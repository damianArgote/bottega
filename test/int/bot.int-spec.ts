import { UNSUPPORTED_REPLY } from '../../src/bot/echo-replies.js';
import {
  EchoReplyGenerator,
  type ReplyGenerator,
  UnimplementedAiReplyGenerator,
} from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import {
  buildBotService,
  connectPrisma,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';

const sent = (id: string): SendOutcome => ({ kind: 'sent', waMessageId: id });
const uncertain: SendOutcome = { kind: 'uncertain', reason: 'http 500' };
const rejected = (code: number, retryable: boolean): SendOutcome => ({
  kind: 'rejected',
  code,
  httpStatus: 400,
  message: 'rejected',
  retryable,
});

describe('BotService two-phase processing (integration)', () => {
  const config = testConfig();
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let generate: ReturnType<typeof vi.fn<ReplyGenerator['generate']>>;
  let worker: BotWorker;

  const buildWorker = (generator: ReplyGenerator) => {
    const queue = new QueueService(prisma, config);
    const bot = buildBotService(prisma, { sendText }, generator);
    return new BotWorker(config, queue, bot);
  };

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    sendText.mockReset();
    const echo = new EchoReplyGenerator();
    generate = vi.fn<ReplyGenerator['generate']>((input) =>
      echo.generate(input),
    );
    worker = buildWorker({ generate });
  });

  const outbound = () =>
    prisma.message.findMany({
      where: { direction: 'OUTBOUND' },
      orderBy: { idempotencyKey: 'asc' },
    });

  const onlyJob = () => prisma.processingJob.findFirstOrThrow();

  /** Makes a job that is waiting for its backoff runnable now. */
  const makeRunnable = () => prisma.$executeRaw`
    UPDATE processing_job SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE status = 'PENDING'`;

  it('happy path: persists the echo reply, sends it and completes', async () => {
    sendText.mockResolvedValue(sent('wamid.out.1'));
    await conversations.recordInbound(textEvent('wamid.in', USER, 'hola'));

    expect(await worker.drain()).toBe(1);

    expect(sendText).toHaveBeenCalledExactlyOnceWith(
      USER,
      'Hola! Soy Bottega 🤖 Recibí tu mensaje: "hola"',
    );
    const job = await onlyJob();
    const conversation = await prisma.conversation.findFirstOrThrow();
    expect(job.status).toBe('COMPLETED');
    expect(await outbound()).toEqual([
      expect.objectContaining({
        status: 'SENT',
        waMessageId: 'wamid.out.1',
        author: 'BOT',
        type: 'TEXT',
        idempotencyKey: `${job.id}:0`,
        contextId: conversation.activeContextId,
      }),
    ]);
    const inbound = await prisma.message.findUniqueOrThrow({
      where: { waMessageId: 'wamid.in' },
    });
    expect(inbound.status).toBe('PROCESSED');
  });

  it('answers unsupported messages with the text-only hint', async () => {
    sendText.mockResolvedValue(sent('wamid.out'));
    await conversations.recordInbound({
      kind: 'unsupported',
      waMessageId: 'wamid.img',
      from: USER,
      timestamp: new Date(),
      messageType: 'image',
    });

    await worker.drain();

    expect(sendText).toHaveBeenCalledExactlyOnceWith(USER, UNSUPPORTED_REPLY);
  });

  it('replies to one conversation in arrival order', async () => {
    sendText.mockImplementation((_to, body) => Promise.resolve(sent(body)));
    for (const text of ['uno', 'dos', 'tres']) {
      await conversations.recordInbound(textEvent(`wamid.${text}`, USER, text));
    }

    await worker.drain();

    expect(sendText.mock.calls.map(([, body]) => body)).toEqual([
      expect.stringContaining('"uno"'),
      expect.stringContaining('"dos"'),
      expect.stringContaining('"tres"'),
    ]);
  });

  it('marks an uncertain send UNCERTAIN and completes without resending', async () => {
    sendText.mockResolvedValue(uncertain);
    await conversations.recordInbound(textEvent('wamid.in'));

    await worker.drain();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await outbound())[0]?.status).toBe('UNCERTAIN');
    expect((await onlyJob()).status).toBe('COMPLETED');
  });

  it('retries a retryable rejection without generating again', async () => {
    sendText
      .mockResolvedValueOnce(rejected(130429, true))
      .mockResolvedValueOnce(sent('wamid.out'));
    await conversations.recordInbound(textEvent('wamid.in'));

    await worker.drain();
    const retrying = await onlyJob();
    expect(retrying).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'JobError:send_rejected_130429',
    });
    expect((await outbound())[0]?.status).toBe('QUEUED');

    await makeRunnable();
    await worker.drain();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect((await outbound())[0]).toMatchObject({
      status: 'SENT',
      waMessageId: 'wamid.out',
    });
    expect(await onlyJob()).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });

  it('never resends an UNCERTAIN reply when the job is retried', async () => {
    generate.mockResolvedValue(['primera', 'segunda']);
    sendText
      .mockResolvedValueOnce(uncertain)
      .mockResolvedValueOnce(rejected(131056, true))
      .mockResolvedValueOnce(sent('wamid.out.2'));
    await conversations.recordInbound(textEvent('wamid.in'));

    await worker.drain();
    await makeRunnable();
    await worker.drain();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls.map(([, body]) => body)).toEqual([
      'primera',
      'segunda',
      'segunda',
    ]);
    expect((await outbound()).map((row) => row.status)).toEqual([
      'UNCERTAIN',
      'SENT',
    ]);
    expect((await onlyJob()).status).toBe('COMPLETED');
  });

  it('fails the reply and the job when retryable rejections exhaust attempts', async () => {
    sendText.mockResolvedValue(rejected(130429, true));
    await conversations.recordInbound(textEvent('wamid.in'));

    for (let i = 0; i < 3; i += 1) {
      await makeRunnable();
      await worker.drain();
    }

    expect(sendText).toHaveBeenCalledTimes(3);
    expect((await outbound())[0]).toMatchObject({
      status: 'FAILED',
      errorCode: '130429',
    });
    expect(await onlyJob()).toMatchObject({ status: 'FAILED', attempts: 3 });
  });

  it('records a non-retryable rejection as FAILED and completes', async () => {
    sendText.mockResolvedValue(rejected(131047, false));
    await conversations.recordInbound(textEvent('wamid.in'));

    await worker.drain();

    expect((await outbound())[0]).toMatchObject({
      status: 'FAILED',
      errorCode: '131047',
    });
    expect((await onlyJob()).status).toBe('COMPLETED');
  });

  it('marks a reply left SENDING by a crash as UNCERTAIN and never resends it', async () => {
    sendText.mockResolvedValueOnce(rejected(130429, true));
    await conversations.recordInbound(textEvent('wamid.in'));
    await worker.drain();
    // State left behind by a worker that died after QUEUED → SENDING but
    // before recording the API outcome.
    await prisma.message.updateMany({
      where: { direction: 'OUTBOUND' },
      data: { status: 'SENDING' },
    });
    await makeRunnable();

    await worker.drain();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await outbound())[0]).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'interrupted_send',
    });
    expect((await onlyJob()).status).toBe('COMPLETED');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not reply in a paused conversation', async () => {
    await conversations.recordInbound(textEvent('wamid.in'));
    await prisma.conversation.updateMany({ data: { paused: true } });

    await worker.drain();

    expect(generate).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(await outbound()).toEqual([]);
    expect((await onlyJob()).status).toBe('COMPLETED');
    const inbound = await prisma.message.findUniqueOrThrow({
      where: { waMessageId: 'wamid.in' },
    });
    expect(inbound.status).toBe('PROCESSED');
  });

  it('does not reply to status events', async () => {
    sendText.mockResolvedValue(sent('wamid.out'));
    await conversations.recordInbound(textEvent('wamid.in'));
    await worker.drain();
    sendText.mockClear();

    await conversations.ingest([
      {
        kind: 'status',
        waMessageId: 'wamid.out',
        status: 'delivered',
        recipientId: USER,
        timestamp: new Date(),
      },
    ]);

    expect(await worker.drain()).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    expect((await outbound())[0]?.status).toBe('DELIVERED');
  });

  it('sends nothing in ai mode until Stage 4 and completes the job', async () => {
    worker = buildWorker(new UnimplementedAiReplyGenerator());
    await conversations.recordInbound(textEvent('wamid.in'));

    await worker.drain();

    expect(sendText).not.toHaveBeenCalled();
    expect(await outbound()).toEqual([]);
    expect((await onlyJob()).status).toBe('COMPLETED');
  });

  it('retries when the generator fails, without persisting anything', async () => {
    generate.mockRejectedValueOnce(new Error('generator down'));
    sendText.mockResolvedValue(sent('wamid.out'));
    await conversations.recordInbound(textEvent('wamid.in'));

    await worker.drain();
    expect(await outbound()).toEqual([]);
    expect((await onlyJob()).status).toBe('PENDING');

    await makeRunnable();
    await worker.drain();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await onlyJob()).status).toBe('COMPLETED');
  });
});
