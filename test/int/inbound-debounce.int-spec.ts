import {
  AiProviderError,
  type AiInputItem,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../../src/ai/ai.provider.js';
import { AiLimitsService } from '../../src/ai/ai-limits.service.js';
import { AiUsageService } from '../../src/ai/ai-usage.service.js';
import { AiReplyGenerator } from '../../src/bot/ai-reply-generator.js';
import { MEDIA_DAILY_CAP_REPLY } from '../../src/bot/media-replies.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContentService } from '../../src/content/content.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { MediaSource } from '../../src/media/line-media.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import {
  buildAttachmentPreparer,
  buildBotService,
  buildBusinessModules,
  connectPrisma,
  DEFAULT_PHONE_NUMBER_ID,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';
const MODEL = 'test-model';
const META_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const text = (outputText: string): AiResponse => ({
  outputText,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: MODEL,
});

/** What the model got for this turn: every item after the history. */
const turnItems = (request: AiRequest | undefined, history = 0) =>
  (request?.input ?? []).slice(history);
const textsOf = (items: AiInputItem[]) =>
  items.flatMap((item) => (item.kind === 'message' ? [item.content] : []));

describe('grouping consecutive inbound messages (integration, mocked model)', () => {
  const config = testConfig({
    BOT_REPLY_MODE: 'ai',
    OPENAI_API_KEY: 'unused',
    OPENAI_MODEL: MODEL,
    INBOUND_DEBOUNCE_MS: 60_000,
  });
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const respond = vi.fn<AiProvider['respond']>();
  const info = vi.fn<MediaSource['info']>();
  const download = vi.fn<MediaSource['download']>();
  const media: MediaSource = {
    info,
    download,
    open: () => Promise.reject(new Error('not used')),
  };
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let queue: QueueService;
  let worker: BotWorker;
  let seq = 0;

  const buildWorker = () => {
    const generator = new AiReplyGenerator({
      provider: { respond },
      usage: new AiUsageService(prisma),
      limits: new AiLimitsService(prisma, config),
      modules: buildBusinessModules(prisma, config),
      prisma,
      content: new ContentService(),
      config,
      // Monday 12:00 in Buenos Aires: no out-of-hours notice.
      clock: () => new Date('2026-10-26T15:00:00Z'),
    });
    const bot = buildBotService(
      prisma,
      { sendText },
      generator,
      buildAttachmentPreparer(prisma, config, media),
    );
    return new BotWorker(config, queue, bot, new QueueSignal());
  };

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    queue = new QueueService(prisma, config);
    worker = buildWorker();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    for (const mock of [sendText, respond, info, download]) {
      mock.mockReset();
    }
    sendText.mockImplementation(() =>
      Promise.resolve({ kind: 'sent', waMessageId: `wamid.out.${(seq += 1)}` }),
    );
    respond.mockResolvedValue(text('¡Dale!'));
  });

  const say = (body: string, service = conversations) =>
    service.recordInbound(textEvent(`wamid.in.${(seq += 1)}`, USER, body));
  const tap = (title: string) =>
    conversations.recordInbound({
      ...textEvent(`wamid.in.${(seq += 1)}`, USER, title),
      tapped: true,
    });
  const sendImage = (caption?: string) =>
    conversations.recordInbound({
      kind: 'unsupported',
      phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
      waMessageId: `wamid.in.${(seq += 1)}`,
      from: USER,
      timestamp: new Date(),
      messageType: 'image',
      media: {
        kind: 'image',
        mediaId: `media-${seq}`,
        mime: 'image/jpeg',
        ...(caption ? { caption } : {}),
      },
    });
  const makeRunnable = () => prisma.$executeRaw`
    UPDATE processing_job SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE status = 'PENDING'`;
  const inboundJobs = () =>
    prisma.processingJob.findMany({
      where: { type: 'INBOUND_MESSAGE' },
      orderBy: { seq: 'asc' },
    });
  const inboundStatuses = async () =>
    (
      await prisma.message.findMany({
        where: { direction: 'INBOUND' },
        orderBy: { seq: 'asc' },
      })
    ).map((m) => m.status);
  const sentBodies = () => sendText.mock.calls.map((call) => call[1]);

  it('three messages one second apart get one model call and one reply', async () => {
    const short = testConfig({ INBOUND_DEBOUNCE_MS: 1_500 });
    const service = new ConversationsService(prisma, short, new QueueSignal());

    await say('hola', service);
    await sleep(1_000);
    await say('quiero precio', service);
    await sleep(1_000);
    await say('para 2 personas', service);

    // 2 s after the first message its own delay is over, but the job moved.
    expect(await worker.processNext()).toBe(false);
    await vi.waitFor(async () => expect(await worker.drain()).toBe(1), {
      timeout: 6_000,
      interval: 100,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(textsOf(turnItems(respond.mock.calls[0]?.[0]))).toEqual([
      'hola',
      'quiero precio',
      'para 2 personas',
    ]);
    expect(sentBodies()).toEqual(['¡Dale!']);
    expect(await inboundStatuses()).toEqual([
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
    ]);
    expect(await inboundJobs()).toMatchObject([{ status: 'COMPLETED' }]);
    expect(await prisma.aiUsage.count()).toBe(1);
  });

  it('delays the job INBOUND_DEBOUNCE_MS and keeps one job per burst', async () => {
    await say('hola');
    const [first] = await inboundJobs();
    await say('quiero precio');

    const jobs = await inboundJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.runAfter.getTime()).toBeGreaterThanOrEqual(
      first!.runAfter.getTime(),
    );
    expect(jobs[0]?.messageId).toBe(first?.messageId);
    const second = await prisma.message.findFirstOrThrow({
      where: { content: 'quiero precio' },
    });
    expect(second.batchJobId).toBe(first?.id);
    expect(await queue.claimNext('w')).toBeNull();
  });

  it('remembers a grouped burst as separate messages in the next turn', async () => {
    await say('hola');
    await say('quiero precio');
    await makeRunnable();
    await worker.drain();

    await say('¿y envíos?');
    await makeRunnable();
    await worker.drain();

    expect(textsOf(turnItems(respond.mock.calls[1]?.[0]))).toEqual([
      'hola',
      'quiero precio',
      '¡Dale!',
      '¿y envíos?',
    ]);
  });

  it('a message that arrives while the job runs waits for its own turn', async () => {
    await say('hola');
    await makeRunnable();
    respond.mockImplementationOnce(async () => {
      await say('¿estás?');
      return text('Primera');
    });
    respond.mockResolvedValueOnce(text('Segunda'));

    await worker.processNext();
    expect(textsOf(turnItems(respond.mock.calls[0]?.[0]))).toEqual(['hola']);
    expect(await inboundStatuses()).toEqual(['PROCESSED', 'RECEIVED']);

    await makeRunnable();
    await worker.processNext();
    expect(textsOf(turnItems(respond.mock.calls[1]?.[0]))).toEqual([
      'hola',
      'Primera',
      '¿estás?',
    ]);
    expect(sentBodies()).toEqual(['Primera', 'Segunda']);
  });

  it('a job waiting to retry takes no new messages, so none is left unanswered', async () => {
    await say('hola');
    await makeRunnable();
    respond.mockRejectedValueOnce(new AiProviderError('ai_rate_limit', true));
    await worker.processNext();
    const [retrying] = await inboundJobs();
    expect(retrying).toMatchObject({ status: 'PENDING', attempts: 1 });
    const backoff = retrying!.runAfter;

    await say('¿estás?');

    const jobs = await inboundJobs();
    expect(jobs).toHaveLength(2);
    // The retry keeps its backoff.
    expect(jobs[0]?.runAfter).toEqual(backoff);

    await makeRunnable();
    respond.mockResolvedValueOnce(text('Primera'));
    respond.mockResolvedValueOnce(text('Segunda'));
    await worker.drain();
    expect(sentBodies()).toEqual(['Primera', 'Segunda']);
    expect(await inboundStatuses()).toEqual(['PROCESSED', 'PROCESSED']);
  });

  it('a job retried after a model failure still answers its whole burst once', async () => {
    await say('hola');
    await say('quiero precio');
    await makeRunnable();
    respond.mockRejectedValueOnce(new AiProviderError('ai_rate_limit', true));
    await worker.processNext();
    expect(await inboundStatuses()).toEqual(['RECEIVED', 'RECEIVED']);

    await makeRunnable();
    await worker.processNext();

    expect(textsOf(turnItems(respond.mock.calls[1]?.[0]))).toEqual([
      'hola',
      'quiero precio',
    ]);
    expect(sentBodies()).toEqual(['¡Dale!']);
    expect(await inboundStatuses()).toEqual(['PROCESSED', 'PROCESSED']);
  });

  it('a command is never merged: what came before, the command, what came after', async () => {
    await say('hola');
    await say('humano');
    await say('¿me atienden?');
    expect(await inboundJobs()).toHaveLength(3);

    await makeRunnable();
    await worker.drain();

    // Only the first text reached the model: the handoff paused the bot.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(textsOf(turnItems(respond.mock.calls[0]?.[0]))).toEqual(['hola']);
    expect(sentBodies()).toHaveLength(2);
    expect(await inboundStatuses()).toEqual([
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
    ]);
    expect((await inboundJobs()).map((job) => job.status)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'SKIPPED',
    ]);
  });

  it('a command runs at once and takes along the burst waiting before it', async () => {
    await say('hola');
    await say('humano');

    // No makeRunnable: neither job waits the 60 s debounce any more.
    expect(await worker.drain()).toBe(2);

    expect(textsOf(turnItems(respond.mock.calls[0]?.[0]))).toEqual(['hola']);
    expect(sentBodies()).toHaveLength(2);
    expect((await inboundJobs()).map((job) => job.status)).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);
  });

  it('a tapped button joins the burst and answers it at once', async () => {
    await say('hola');
    await tap('Plan Pro');
    expect(await inboundJobs()).toHaveLength(1);

    expect(await worker.drain()).toBe(1);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(textsOf(turnItems(respond.mock.calls[0]?.[0]))).toEqual([
      'hola',
      'Plan Pro',
    ]);
    expect(sentBodies()).toEqual(['¡Dale!']);
    expect(await inboundStatuses()).toEqual(['PROCESSED', 'PROCESSED']);
  });

  it('a tapped button alone is answered at once', async () => {
    await tap('Probar la demo');
    expect(await worker.drain()).toBe(1);
    expect(sentBodies()).toHaveLength(1);
  });

  it('a retry keeps its backoff when a command arrives', async () => {
    await say('hola');
    await prisma.$executeRaw`
      UPDATE processing_job SET attempts = 1 WHERE type = 'INBOUND_MESSAGE'`;
    await say('humano');
    // The retried job still waits, and the command waits behind it.
    expect(await queue.claimNext('w')).toBeNull();
  });

  it('a person taking the conversation marks the whole burst processed, no reply', async () => {
    await say('hola');
    await say('quiero precio');
    await prisma.conversation.updateMany({ data: { paused: true } });
    await makeRunnable();

    await worker.drain();

    expect(respond).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(await inboundStatuses()).toEqual(['PROCESSED', 'PROCESSED']);
    expect(await inboundJobs()).toMatchObject([{ status: 'SKIPPED' }]);
  });

  it('an image and the text after it go in one turn', async () => {
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'image/jpeg',
      fileSize: 2000,
    });
    download.mockResolvedValue(Buffer.from('image-bytes'));
    await sendImage('esta');
    await say('¿cuánto sale?');
    await makeRunnable();

    await worker.drain();

    expect(respond).toHaveBeenCalledTimes(1);
    const [first, second] = turnItems(respond.mock.calls[0]?.[0]);
    expect(first).toMatchObject({
      kind: 'parts',
      content: [
        { kind: 'text', text: '[Imagen] esta' },
        { kind: 'image', dataUrl: expect.stringContaining('base64') as string },
      ],
    });
    expect(second).toMatchObject({ kind: 'message', content: '¿cuánto sale?' });
    expect(sentBodies()).toEqual(['¡Dale!']);
  });

  it('renews the lease before each further attachment of a burst', async () => {
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'image/jpeg',
      fileSize: 2000,
    });
    const extendLease = vi.spyOn(QueueService.prototype, 'extendLease');
    download.mockResolvedValue(Buffer.from('image-bytes'));
    await sendImage();
    await sendImage();
    await sendImage();
    await makeRunnable();

    await worker.drain();

    expect(extendLease).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledTimes(1);
    extendLease.mockRestore();
  });

  it('counts the attachments of a burst against the daily attachment cap', async () => {
    await prisma.business.updateMany({
      data: { mediaDailyCapPerConversation: 1 },
    });
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'image/jpeg',
      fileSize: 2000,
    });
    download.mockResolvedValue(Buffer.from('image-bytes'));
    await sendImage();
    await sendImage();
    await sendImage();
    await makeRunnable();

    await worker.drain();

    expect(download).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(sentBodies()).toEqual([MEDIA_DAILY_CAP_REPLY, '¡Dale!']);
    const stored = await prisma.message.findMany({
      where: { direction: 'INBOUND' },
      orderBy: { seq: 'asc' },
    });
    expect(stored.map((m) => m.mediaError)).toEqual([
      null,
      'daily_cap',
      'daily_cap',
    ]);
  });

  it('an attachment that cannot be read keeps its fixed reply, and the text is answered', async () => {
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'image/jpeg',
      fileSize: 999_999_999,
    });
    await sendImage();
    await say('¿cuánto sale?');
    await makeRunnable();

    await worker.drain();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(textsOf(turnItems(respond.mock.calls[0]?.[0]))).toEqual([
      '¿cuánto sale?',
    ]);
    expect(sentBodies()).toHaveLength(2);
    expect(sentBodies()[1]).toBe('¡Dale!');
  });

  it('never strands a message when it races with the worker taking the job', async () => {
    const service = new ConversationsService(
      prisma,
      testConfig({ INBOUND_DEBOUNCE_MS: 1 }),
      new QueueSignal(),
    );
    const race = async () => {
      for (let round = 0; round < 40; round += 1) {
        await say(`mensaje ${round}`, service);
      }
    };
    const drainLoop = async (done: () => boolean) => {
      while (!done()) {
        await worker.drain();
        await sleep(1);
      }
    };
    let finished = false;
    await Promise.all([
      race().finally(() => {
        finished = true;
      }),
      drainLoop(() => finished),
    ]);
    await sleep(5);
    await worker.drain();

    const statuses = await inboundStatuses();
    expect(statuses).toHaveLength(40);
    expect(new Set(statuses)).toEqual(new Set(['PROCESSED']));
    const jobs = await inboundJobs();
    expect(new Set(jobs.map((job) => job.status))).toEqual(
      new Set(['COMPLETED']),
    );
  });

  describe('with INBOUND_DEBOUNCE_MS=0', () => {
    const off = () =>
      new ConversationsService(
        prisma,
        testConfig({ INBOUND_DEBOUNCE_MS: 0 }),
        new QueueSignal(),
      );

    it('each message keeps its own job, runnable at once and answered alone', async () => {
      const service = off();
      await say('hola', service);
      await say('quiero precio', service);
      expect(await inboundJobs()).toHaveLength(2);

      respond.mockResolvedValueOnce(text('Primera'));
      respond.mockResolvedValueOnce(text('Segunda'));
      expect(await worker.drain()).toBe(2);

      expect(sentBodies()).toEqual(['Primera', 'Segunda']);
    });
  });
});
