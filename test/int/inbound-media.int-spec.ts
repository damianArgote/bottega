import { Logger } from '@nestjs/common';
import { AiLimitsService } from '../../src/ai/ai-limits.service.js';
import {
  AiProviderError,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../../src/ai/ai.provider.js';
import { AiUsageService } from '../../src/ai/ai-usage.service.js';
import type { AiTranscriber } from '../../src/ai/transcriber.js';
import { AiReplyGenerator } from '../../src/bot/ai-reply-generator.js';
import {
  AUDIO_FAILED_REPLY,
  AUDIO_TOO_LARGE_REPLY,
  audioTooLongReply,
  MEDIA_DAILY_CAP_REPLY,
  MEDIA_GONE_REPLY,
  MEDIA_UNSUPPORTED_REPLY,
} from '../../src/bot/media-replies.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContentService } from '../../src/content/content.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { MediaSource } from '../../src/media/line-media.service.js';
import { MediaFetchError } from '../../src/media/meta-media.client.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { InboundMedia } from '../../src/whatsapp/inbound-event.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import { oggOpusOf } from '../fixtures/ogg-opus.js';
import {
  buildAttachmentPreparer,
  buildBotService,
  buildCatalogService,
  connectPrisma,
  DEFAULT_PHONE_NUMBER_ID,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';
const MODEL = 'test-model';
const META_URL =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';

const text = (outputText: string): AiResponse => ({
  outputText,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: MODEL,
});

describe('Inbound attachments (integration, Meta and OpenAI mocked)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const respond = vi.fn<AiProvider['respond']>();
  const transcribe = vi.fn<AiTranscriber['transcribe']>();
  const info = vi.fn<MediaSource['info']>();
  const download = vi.fn<MediaSource['download']>();
  const media: MediaSource = {
    info,
    download,
    open: () => Promise.reject(new Error('not used')),
  };
  const config = testConfig({
    BOT_REPLY_MODE: 'ai',
    OPENAI_API_KEY: 'unused',
    OPENAI_MODEL: MODEL,
    JOB_MAX_ATTEMPTS: 2,
  });
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let worker: BotWorker;
  let seq = 0;

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    const generator = new AiReplyGenerator({
      provider: { respond },
      usage: new AiUsageService(prisma),
      limits: new AiLimitsService(prisma, config),
      catalog: buildCatalogService(prisma, config),
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
      buildAttachmentPreparer(prisma, config, media, { transcribe }),
    );
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      bot,
      new QueueSignal(),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    for (const mock of [sendText, respond, transcribe, info, download]) {
      mock.mockReset();
    }
    sendText.mockImplementation(() =>
      Promise.resolve({ kind: 'sent', waMessageId: `wamid.out.${(seq += 1)}` }),
    );
    respond.mockResolvedValue(text('¡Dale! Te lo anoto.'));
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'audio/ogg',
      fileSize: 2000,
    });
    download.mockResolvedValue(oggOpusOf(8));
    transcribe.mockResolvedValue({
      text: 'quiero un kilo de chocolate',
      model: 'transcribe-model',
    });
  });

  const receive = async (media: InboundMedia, caption?: string) => {
    const id = `wamid.in.${(seq += 1)}`;
    await conversations.recordInbound({
      kind: 'unsupported',
      phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
      waMessageId: id,
      from: USER,
      timestamp: new Date(),
      messageType: media.kind,
      media: { ...media, ...(caption ? { caption } : {}) },
    });
    return id;
  };
  const voiceNote = (extra: Partial<InboundMedia> = {}): InboundMedia => ({
    kind: 'audio',
    mediaId: 'media-audio',
    mime: 'audio/ogg; codecs=opus',
    voice: true,
    ...extra,
  });
  const drain = () => worker.drain();
  const makeRunnable = () => prisma.$executeRaw`
    UPDATE processing_job SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE status = 'PENDING'`;
  const message = (waMessageId: string) =>
    prisma.message.findUniqueOrThrow({ where: { waMessageId } });
  const lastSent = () => sendText.mock.calls.at(-1)?.[1];
  const userText = (request: AiRequest | undefined) => {
    const last = request?.input.at(-1);
    return last?.kind === 'message' ? last.content : last;
  };

  it('downloads a voice note, transcribes it once, answers in text and counts the call', async () => {
    const id = await receive(voiceNote());
    const before = (await prisma.conversation.findFirstOrThrow()).updatedAt;

    await drain();

    expect(info).toHaveBeenCalledWith(expect.any(String), 'media-audio');
    expect(download).toHaveBeenCalledWith(
      expect.any(String),
      META_URL,
      1_000_000,
    );
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0].mimeType).toBe(
      'audio/ogg; codecs=opus',
    );
    expect(await message(id)).toMatchObject({
      transcript: 'quiero un kilo de chocolate',
      mediaError: null,
      status: 'PROCESSED',
    });
    expect(userText(respond.mock.calls[0]?.[0])).toBe(
      '[Audio transcrito] quiero un kilo de chocolate',
    );
    expect(lastSent()).toBe('¡Dale! Te lo anoto.');
    const usage = await prisma.aiUsage.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(usage.map((u) => [u.model, u.outcome])).toEqual([
      ['transcribe-model', 'OK'],
      [MODEL, 'OK'],
    ]);
    // Touched, so the inbox refetches the thread with the transcript.
    expect(
      (await prisma.conversation.findFirstOrThrow()).updatedAt.getTime(),
    ).toBeGreaterThan(before.getTime());
  });

  it('a retried job does not transcribe again', async () => {
    respond
      .mockRejectedValueOnce(new AiProviderError('openai_http_503', true))
      .mockResolvedValue(text('Listo.'));
    const id = await receive(voiceNote());

    await drain();
    await makeRunnable();
    await drain();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(lastSent()).toBe('Listo.');
    expect((await message(id)).transcript).toBe('quiero un kilo de chocolate');
  });

  it('a retryable transcription error retries; on the last attempt, the fixed text and no handoff', async () => {
    transcribe.mockRejectedValue(new AiProviderError('openai_timeout', true));
    const id = await receive(voiceNote());

    await drain();
    expect(sendText).not.toHaveBeenCalled();
    await makeRunnable();
    await drain();

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(await message(id)).toMatchObject({
      mediaError: 'transcription_failed',
    });
    expect(lastSent()).toBe(AUDIO_FAILED_REPLY);
    expect(respond).not.toHaveBeenCalled();
    expect(await prisma.handoffRequest.count()).toBe(0);
  });

  it('an empty transcription answers the fixed text', async () => {
    transcribe.mockResolvedValue({ text: '   ', model: 'transcribe-model' });
    const id = await receive(voiceNote());

    await drain();

    expect((await message(id)).mediaError).toBe('empty_transcript');
    expect(lastSent()).toBe(AUDIO_FAILED_REPLY);
  });

  it('a transcript never runs a command', async () => {
    transcribe.mockResolvedValue({ text: 'humano', model: 'transcribe-model' });
    await receive(voiceNote());

    await drain();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(userText(respond.mock.calls[0]?.[0])).toBe(
      '[Audio transcrito] humano',
    );
    expect(await prisma.handoffRequest.count()).toBe(0);
    expect((await prisma.conversation.findFirstOrThrow()).paused).toBe(false);
  });

  it('with the conversation paused, the audio is transcribed for the inbox and the bot does not answer', async () => {
    await conversations.recordInbound(textEvent('wamid.first', USER, 'hola'));
    await drain();
    sendText.mockClear();
    respond.mockClear();
    await prisma.conversation.updateMany({ data: { paused: true } });
    const id = await receive(voiceNote());

    await drain();

    expect((await message(id)).transcript).toBe('quiero un kilo de chocolate');
    expect(respond).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('an image goes to the model with its caption, and the next turn only as text', async () => {
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'image/jpeg',
      fileSize: 1000,
    });
    download.mockResolvedValue(Buffer.from('jpeg-bytes'));
    await receive(
      { kind: 'image', mediaId: 'media-img', mime: 'image/jpeg' },
      '¿Tienen esta torta?',
    );

    await drain();

    expect(download).toHaveBeenCalledWith(
      expect.any(String),
      META_URL,
      5_000_000,
    );
    expect(respond.mock.calls[0]?.[0].input.at(-1)).toEqual({
      kind: 'parts',
      content: [
        { kind: 'text', text: '[Imagen] ¿Tienen esta torta?' },
        {
          kind: 'image',
          dataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
        },
      ],
    });

    await conversations.recordInbound(
      textEvent(`wamid.in.${(seq += 1)}`, USER, '¿y cuánto sale?'),
    );
    await drain();

    const history = respond.mock.calls[1]?.[0].input ?? [];
    expect(history).toContainEqual({
      kind: 'message',
      role: 'user',
      content: '[Imagen] ¿Tienen esta torta?',
    });
    expect(JSON.stringify(history)).not.toContain('base64');
  });

  it('a PDF goes to the model as a file', async () => {
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'application/pdf',
      fileSize: 1000,
    });
    download.mockResolvedValue(Buffer.from('%PDF'));
    await receive({
      kind: 'document',
      mediaId: 'media-doc',
      mime: 'application/pdf',
      filename: 'pedido.pdf',
    });

    await drain();

    expect(respond.mock.calls[0]?.[0].input.at(-1)).toMatchObject({
      kind: 'parts',
      content: [
        { kind: 'text', text: '[PDF: pedido.pdf]' },
        { kind: 'file', filename: 'pedido.pdf' },
      ],
    });
  });

  it('with the monthly cap reached nothing is downloaded or transcribed', async () => {
    await prisma.business.updateMany({ data: { aiMonthlyCap: 1 } });
    await conversations.recordInbound(textEvent('wamid.first', USER, 'hola'));
    await drain();
    const id = await receive(voiceNote());

    await drain();

    expect(info).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect((await message(id)).mediaError).toBe('ai_cap');
    // The 09 monthly cap handling answers (handoff with its fixed text).
    expect(await prisma.handoffRequest.count()).toBe(1);
  });

  it('an audio at the cap boundary is answered: the caps are checked once, before transcribing', async () => {
    await prisma.business.updateMany({
      data: { aiDailyCapPerConversation: 1, aiMonthlyCap: 1 },
    });
    await receive(voiceNote());

    await drain();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(lastSent()).toBe('¡Dale! Te lo anoto.');
    expect(await prisma.handoffRequest.count()).toBe(0);
  });

  it('an attachment the bot did not read does not count for the daily attachment cap', async () => {
    await prisma.business.updateMany({
      data: { mediaDailyCapPerConversation: 1 },
    });
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'image/jpeg',
      fileSize: 10,
    });
    download.mockResolvedValue(Buffer.from('jpeg'));
    await conversations.recordInbound(textEvent('wamid.first', USER, 'hola'));
    await drain();
    await prisma.conversation.updateMany({ data: { paused: true } });
    const paused = await receive({
      kind: 'image',
      mediaId: 'p',
      mime: 'image/jpeg',
    });
    await drain();
    expect((await message(paused)).mediaError).toBe('skipped');
    expect(download).not.toHaveBeenCalled();

    await prisma.conversation.updateMany({ data: { paused: false } });
    respond.mockClear();
    const next = await receive({
      kind: 'image',
      mediaId: 'q',
      mime: 'image/jpeg',
    });
    await drain();

    expect((await message(next)).mediaError).toBeNull();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('a size the webhook already reports is refused before the AI caps', async () => {
    await prisma.business.updateMany({ data: { aiMonthlyCap: 1 } });
    await conversations.recordInbound(textEvent('wamid.first', USER, 'hola'));
    await drain();
    const id = await receive(voiceNote({ size: 5_000_000 }));

    await drain();

    expect((await message(id)).mediaError).toBe('too_large');
  });

  it('a voice note longer than the limit is not transcribed and answers the limit; the business can raise it', async () => {
    download.mockResolvedValue(oggOpusOf(185));
    const id = await receive(voiceNote());

    await drain();

    expect(transcribe).not.toHaveBeenCalled();
    expect((await message(id)).mediaError).toBe('too_long');
    expect(lastSent()).toBe(audioTooLongReply(120));
    expect(await prisma.aiUsage.count()).toBe(0);

    await prisma.business.updateMany({ data: { audioMaxSeconds: 300 } });
    await receive(voiceNote({ mediaId: 'media-audio-2' }));
    await drain();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('an audio heavier than the limit is not even downloaded', async () => {
    const id = await receive(voiceNote({ size: 2_000_000 }));

    await drain();

    expect(info).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect((await message(id)).mediaError).toBe('too_large');
    expect(lastSent()).toBe(AUDIO_TOO_LARGE_REPLY);

    // Meta's size counts too.
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'audio/ogg',
      fileSize: 5_000_000,
    });
    await receive(voiceNote({ mediaId: 'media-audio-2' }));
    await drain();
    expect(download).not.toHaveBeenCalled();
  });

  it('the attachment after the daily limit answers the fixed text; rejected ones do not count', async () => {
    await prisma.business.updateMany({
      data: { mediaDailyCapPerConversation: 2 },
    });
    // Rejected by size: does not count for the cap.
    await receive(voiceNote({ mediaId: 'big', size: 9_000_000 }));
    await drain();
    for (const mediaId of ['a', 'b']) {
      await receive(voiceNote({ mediaId }));
      await drain();
    }
    expect(transcribe).toHaveBeenCalledTimes(2);
    respond.mockClear();

    const id = await receive(voiceNote({ mediaId: 'c' }));
    await drain();

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(respond).not.toHaveBeenCalled();
    expect((await message(id)).mediaError).toBe('daily_cap');
    expect(lastSent()).toBe(MEDIA_DAILY_CAP_REPLY);
  });

  it('formats it cannot open answer the fixed text without calling anyone', async () => {
    const amr = await receive(voiceNote({ mime: 'audio/amr' }));
    await drain();
    expect((await message(amr)).mediaError).toBe('unsupported_type');
    expect(lastSent()).toBe(MEDIA_UNSUPPORTED_REPLY);

    for (const media of [
      { kind: 'video', mediaId: 'v', mime: 'video/mp4' },
      { kind: 'sticker', mediaId: 's', mime: 'image/webp' },
      {
        kind: 'document',
        mediaId: 'd',
        mime: 'application/msword',
        filename: 'a.doc',
      },
    ] as const) {
      await receive(media);
      await drain();
      expect(lastSent()).toBe(MEDIA_UNSUPPORTED_REPLY);
    }
    expect(info).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('a file Meta no longer has answers that it could not open it', async () => {
    info.mockRejectedValue(new MediaFetchError('media_gone', false));
    const id = await receive(voiceNote());

    await drain();

    expect((await message(id)).mediaError).toBe('media_gone');
    expect(lastSent()).toBe(MEDIA_GONE_REPLY);
  });

  it('a row of the previous release (no media kind) answers the fixed text', async () => {
    await conversations.recordInbound({
      kind: 'unsupported',
      phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
      waMessageId: 'wamid.legacy',
      from: USER,
      timestamp: new Date(),
      messageType: 'image',
    });

    await drain();

    expect(lastSent()).toBe(MEDIA_UNSUPPORTED_REPLY);
    expect(info).not.toHaveBeenCalled();
  });

  it('never logs the transcript or the caption at info', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    try {
      await receive(voiceNote());
      await drain();
      info.mockResolvedValue({
        url: META_URL,
        mimeType: 'image/jpeg',
        fileSize: 10,
      });
      download.mockResolvedValue(Buffer.from('jpeg'));
      await receive(
        { kind: 'image', mediaId: 'img', mime: 'image/jpeg' },
        'caption privado',
      );
      await drain();

      const lines = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(lines).not.toContain('quiero un kilo');
      expect(lines).not.toContain('caption privado');
      expect(lines).not.toContain(META_URL);
    } finally {
      log.mockRestore();
    }
  });
});
