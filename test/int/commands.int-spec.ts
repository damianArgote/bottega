import { QueueSignal } from '../../src/queue/queue-signal.js';
import { renderReply } from '../../src/bot/replies.js';
import {
  EchoReplyGenerator,
  type ReplyGenerator,
  type ReplyInput,
} from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContentService } from '../../src/content/content.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { DemosService } from '../../src/demos/demos.service.js';
import { LeadsService } from '../../src/leads/leads.service.js';
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
const content = new ContentService();
const vars = {
  demoBusinessName: content.getBarbershop().name,
  // resetDb seeds the profile with the test business's botName.
  botName: 'Bot de botsuite46',
};

describe('Deterministic commands and contexts (integration)', () => {
  const config = testConfig();
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let generate: ReturnType<typeof vi.fn<ReplyGenerator['generate']>>;
  let worker: BotWorker;
  let seq = 0;

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    sendText.mockReset();
    sendText.mockImplementation(() =>
      Promise.resolve({ kind: 'sent', waMessageId: `wamid.out.${(seq += 1)}` }),
    );
    const echo = new EchoReplyGenerator();
    generate = vi.fn<ReplyGenerator['generate']>((input) =>
      echo.generate(input),
    );
    const bot = buildBotService(prisma, { sendText }, { generate });
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      bot,
      new QueueSignal(),
    );
  });

  /** Records one user text and processes it. */
  const say = async (text: string) => {
    await conversations.recordInbound(
      textEvent(`wamid.in.${(seq += 1)}`, USER, text),
    );
    await worker.drain();
  };

  const conversation = () =>
    prisma.conversation.findFirstOrThrow({ include: { contexts: true } });

  /** History of one context, the way the AI pipeline will read it. */
  const history = (contextId: string) =>
    prisma.message.findMany({
      where: { contextId },
      orderBy: { createdAt: 'asc' },
    });

  const lastSent = () => sendText.mock.calls.at(-1)?.[1];

  it('isolates commercial and demo history across demo → salir', async () => {
    await say('hola');
    const commercial = (await conversation()).activeContextId!;

    await say('Demo');
    const afterDemo = await conversation();
    const demo = afterDemo.activeContextId!;
    expect(afterDemo.mode).toBe('DEMO');
    expect(demo).not.toBe(commercial);
    expect(lastSent()).toBe(renderReply('ENTER_DEMO', vars));

    await say('¿Qué servicios tienen?');
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining<Partial<ReplyInput>>({
        mode: 'DEMO',
        contextId: demo,
      }),
    );

    await say('salir');
    const afterExit = await conversation();
    const commercial2 = afterExit.activeContextId!;
    expect(afterExit.mode).toBe('COMMERCIAL');
    expect(commercial2).not.toBe(commercial);
    expect(commercial2).not.toBe(demo);
    expect(lastSent()).toBe(renderReply('EXIT_DEMO', vars));

    // Old contexts are closed, never re-opened.
    const byId = new Map(afterExit.contexts.map((c) => [c.id, c]));
    expect(byId.get(commercial)).toMatchObject({
      mode: 'COMMERCIAL',
      endReason: 'MODE_SWITCH',
    });
    expect(byId.get(demo)).toMatchObject({
      mode: 'DEMO',
      endReason: 'MODE_SWITCH',
    });
    expect(byId.get(commercial2)).toMatchObject({ endedAt: null });

    // The command message stays in the context it closed; the demo history
    // starts with the disclaimer and holds only demo traffic.
    expect((await history(commercial)).map((m) => m.content)).toEqual([
      'hola',
      expect.stringContaining('"hola"'),
      'Demo',
    ]);
    expect((await history(demo)).map((m) => m.content)).toEqual([
      renderReply('ENTER_DEMO', vars),
      '¿Qué servicios tienen?',
      expect.stringContaining('servicios'),
      'salir',
    ]);
    expect((await history(commercial2)).map((m) => m.content)).toEqual([
      renderReply('EXIT_DEMO', vars),
    ]);
  });

  it('moves a message received before a switch into the context that answers it', async () => {
    await say('hola');
    // "demo" and the next message arrive before the worker runs.
    await conversations.recordInbound(textEvent('wamid.a', USER, 'demo'));
    await conversations.recordInbound(textEvent('wamid.b', USER, 'precios?'));
    await worker.drain();

    const { activeContextId } = await conversation();
    const late = await prisma.message.findUniqueOrThrow({
      where: { waMessageId: 'wamid.b' },
    });
    expect(late.contextId).toBe(activeContextId);
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'DEMO', contextId: activeContextId }),
    );
  });

  it('answers no-op commands without changing the context', async () => {
    await say('salir');
    const first = await conversation();
    expect(lastSent()).toBe(renderReply('NOT_IN_DEMO', vars));

    await say('demo');
    await say('demo');
    expect(lastSent()).toBe(renderReply('ALREADY_IN_DEMO', vars));
    const after = await conversation();
    expect(after.contexts).toHaveLength(2);
    expect(after.contexts.map((c) => c.id)).toContain(first.activeContextId);
  });

  it('reiniciar keeps the lead and old messages and opens a same-mode context', async () => {
    await say('hola');
    const before = await conversation();
    await new LeadsService(prisma).upsertFromConversation(before.id, {
      name: 'Ana',
      need: 'turnos',
    });

    await say('reiniciar');

    const after = await conversation();
    expect(after.mode).toBe('COMMERCIAL');
    expect(after.activeContextId).not.toBe(before.activeContextId);
    expect(
      after.contexts.find((c) => c.id === before.activeContextId),
    ).toMatchObject({ endReason: 'RESET' });
    expect(
      await prisma.lead.findUniqueOrThrow({
        where: { conversationId: after.id },
      }),
    ).toMatchObject({
      data: { name: 'Ana', need: 'turnos' },
    });
    expect((await history(before.activeContextId!)).length).toBe(3);
    expect(
      (await history(after.activeContextId!)).map((m) => m.content),
    ).toEqual([renderReply('RESET_COMMERCIAL', vars)]);
  });

  it('reiniciar inside the demo stays in demo mode', async () => {
    await say('demo');
    await say('reiniciar');

    const after = await conversation();
    expect(after.mode).toBe('DEMO');
    expect(after.contexts.filter((c) => c.mode === 'DEMO')).toHaveLength(2);
    expect(lastSent()).toBe(renderReply('RESET_DEMO', vars));
  });

  it('humano pauses, opens a handoff and then stays silent, even for commands', async () => {
    await say('hola');
    await say('Hablar con una persona');

    const paused = await conversation();
    expect(paused.paused).toBe(true);
    expect(paused.pausedAt).toBeInstanceOf(Date);
    expect(await prisma.handoffRequest.findMany()).toEqual([
      expect.objectContaining({ status: 'OPEN', reason: 'user_command' }),
    ]);
    expect(lastSent()).toBe(renderReply('HUMAN_REQUESTED', vars));
    const sends = sendText.mock.calls.length;

    await say('demo');
    await say('sigo acá?');

    expect(sendText).toHaveBeenCalledTimes(sends);
    const after = await conversation();
    expect(after.mode).toBe('COMMERCIAL');
    expect(after.contexts).toHaveLength(1);
    expect(await prisma.handoffRequest.count()).toBe(1);
    const inbound = await prisma.message.findMany({
      where: { direction: 'INBOUND', content: { in: ['demo', 'sigo acá?'] } },
    });
    expect(inbound.map((m) => m.status)).toEqual(['PROCESSED', 'PROCESSED']);
  });

  it('never re-applies a transition when the job is retried', async () => {
    sendText.mockResolvedValueOnce({
      kind: 'rejected',
      code: 130429,
      httpStatus: 429,
      message: 'rate limited',
      retryable: true,
    });
    await say('demo');
    const job = await prisma.processingJob.findFirstOrThrow();
    expect(job.status).toBe('PENDING');

    await prisma.$executeRaw`
      UPDATE processing_job SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'`;
    await worker.drain();

    const after = await conversation();
    expect(after.mode).toBe('DEMO');
    expect(after.contexts).toHaveLength(2);
    const outbound = await prisma.message.findMany({
      where: { direction: 'OUTBOUND' },
    });
    expect(outbound).toEqual([
      expect.objectContaining({
        status: 'SENT',
        contextId: after.activeContextId,
        content: renderReply('ENTER_DEMO', vars),
      }),
    ]);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(await prisma.processingJob.findFirstOrThrow()).toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('humano confirmation is still sent when its job is retried after pausing', async () => {
    sendText.mockResolvedValueOnce({
      kind: 'rejected',
      code: 130429,
      httpStatus: 429,
      message: 'rate limited',
      retryable: true,
    });
    await say('humano');
    await prisma.$executeRaw`
      UPDATE processing_job SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'`;
    await worker.drain();

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(lastSent()).toBe(renderReply('HUMAN_REQUESTED', vars));
    expect(await prisma.handoffRequest.count()).toBe(1);
  });

  it('commands work with the ai generator too (no generator call)', async () => {
    const aiGenerate = vi
      .fn<ReplyGenerator['generate']>()
      .mockResolvedValue({ replies: [], effects: [] });
    const bot = buildBotService(prisma, { sendText }, { generate: aiGenerate });
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      bot,
      new QueueSignal(),
    );

    await say('demo');

    expect(aiGenerate).not.toHaveBeenCalled();
    expect(lastSent()).toBe(renderReply('ENTER_DEMO', vars));
  });

  describe('LeadsService', () => {
    it('merges fields and never blanks known data', async () => {
      await say('hola');
      const { id } = await conversation();
      const leads = new LeadsService(prisma);

      await leads.upsertFromConversation(id, {
        name: 'Ana',
        industry: 'salud',
      });
      await leads.upsertFromConversation(id, {
        name: '',
        industry: '  ',
        business_name: 'Consultorio Sur',
      });

      expect(await prisma.lead.findMany()).toEqual([
        expect.objectContaining({
          conversationId: id,
          data: {
            name: 'Ana',
            industry: 'salud',
            business_name: 'Consultorio Sur',
          },
          status: 'NEW',
        }),
      ]);
    });
  });

  describe('DemosService', () => {
    it('stores a fictitious request in the demo context', async () => {
      await say('demo');
      const { id, activeContextId } = await conversation();

      const request = await new DemosService(
        prisma,
        content,
      ).registerDemoRequest(id, activeContextId!, {
        customerName: 'Juan',
        service: 'Corte de pelo',
        preferredDate: 'sábado',
        preferredTime: '11:00',
      });

      expect(request).toMatchObject({
        scenario: 'barbershop',
        isFictitious: true,
        contextId: activeContextId,
      });
    });
  });
});
