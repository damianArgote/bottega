import { createHmac } from 'node:crypto';
import { ActionCallerService } from '../../src/actions/action-caller.service.js';
import { AgentActionsService } from '../../src/actions/agent-actions.service.js';
import {
  AiProviderError,
  type AiInputItem,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../../src/ai/ai.provider.js';
import { AiLimitsService } from '../../src/ai/ai-limits.service.js';
import { AiUsageService } from '../../src/ai/ai-usage.service.js';
import { ACTION_FAILED_REPLY } from '../../src/bot/ai-replies.js';
import { AiReplyGenerator } from '../../src/bot/ai-reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContentService } from '../../src/content/content.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { createSafeFetch } from '../../src/integrations/safe-fetch.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import {
  buildBotService,
  buildBusinessModules,
  connectPrisma,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';
const MODEL = 'test-model';

const text = (outputText: string): AiResponse => ({
  outputText,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: MODEL,
});

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): AiResponse => ({
  outputText: '',
  toolCalls: [
    { callId: `call_${(callSeq += 1)}`, name, arguments: JSON.stringify(args) },
  ],
  usage: { inputTokens: 20, outputTokens: 8 },
  model: MODEL,
});

const toolResults = (request: AiRequest | undefined) =>
  (request?.input ?? []).flatMap((item: AiInputItem) =>
    item.kind === 'tool_result'
      ? [JSON.parse(item.output) as Record<string, unknown>]
      : [],
  );

const booking = {
  name: 'reservar_turno',
  description: 'Reserva un turno en la agenda del negocio.',
  parameters: {
    type: 'object' as const,
    properties: {
      dia: { type: 'string' as const, maxLength: 30 },
      hora: { type: 'string' as const, maxLength: 5 },
    },
    required: ['dia', 'hora'],
  },
  url: 'https://n8n.example.com/webhook/turnos',
  kind: 'effect' as const,
  timeoutMs: 5000,
  active: true,
};

describe('Business actions in the bot (integration, mocked model)', () => {
  const config = testConfig();
  const aiConfig = testConfig({
    BOT_REPLY_MODE: 'ai',
    OPENAI_API_KEY: 'unused',
    OPENAI_MODEL: MODEL,
  });
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const respond = vi.fn<AiProvider['respond']>();
  const actionFetch = vi.fn<typeof fetch>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let worker: BotWorker;
  let actions: AgentActionsService;
  let seq = 0;

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    const credentials = new LineCredentialsService(aiConfig);
    actions = new AgentActionsService(
      prisma,
      credentials,
      new ActionCallerService(prisma, credentials, actionFetch),
    );
    const generator = new AiReplyGenerator({
      provider: { respond },
      usage: new AiUsageService(prisma),
      limits: new AiLimitsService(prisma, aiConfig),
      modules: buildBusinessModules(prisma, aiConfig, actionFetch),
      prisma,
      content: new ContentService(),
      config: aiConfig,
      // Monday 12:00 in Buenos Aires: no out-of-hours notice.
      clock: () => new Date('2026-10-26T15:00:00Z'),
    });
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      buildBotService(prisma, { sendText }, generator),
      new QueueSignal(),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let businessId: string;
  let secret: string;

  beforeEach(async () => {
    await resetDb(prisma);
    respond.mockReset();
    sendText.mockReset();
    sendText.mockImplementation(() =>
      Promise.resolve({ kind: 'sent', waMessageId: `wamid.out.${(seq += 1)}` }),
    );
    actionFetch.mockReset();
    actionFetch.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          reply: 'Te reservé el jueves a las 10.',
          data: { turno: 'jueves 10:00' },
        }),
      ),
    );
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    secret = (await actions.create(businessId, booking)).secret;
  });

  const say = async (body: string) => {
    await conversations.recordInbound({
      ...textEvent(`wamid.in.${(seq += 1)}`, USER, body),
      profileName: 'Juan',
    });
    await worker.drain();
  };
  const makeRunnable = () => prisma.$executeRaw`
    UPDATE processing_job SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE status = 'PENDING'`;
  const request = (index: number) => respond.mock.calls.at(index)?.[0];
  const sent = () => sendText.mock.calls.map((c) => c[1]);
  const reserve = tool('reservar_turno', { dia: 'jueves', hora: '10:00' });

  it('offers each active action as a tool, with its schema, only in commercial mode', async () => {
    await actions.create(businessId, {
      ...booking,
      name: 'apagada',
      active: false,
    });
    respond.mockResolvedValueOnce(text('¡Hola!'));

    await say('hola');

    const tools = request(0)!.tools;
    expect(tools.map((t) => t.name)).toEqual([
      'save_lead',
      'request_handoff',
      'offer_options',
      'reservar_turno',
    ]);
    expect(tools.at(-1)).toMatchObject({
      description: expect.stringContaining(
        'Reserva un turno en la agenda del negocio.',
      ) as string,
      parameters: {
        required: ['dia', 'hora'],
        additionalProperties: false,
      },
    });
    expect(request(0)!.instructions).toContain('Las acciones del negocio');
  });

  it('calls it signed, with the conversation, contact, arguments and an idempotency key; sends its reply as is and gives the model its data', async () => {
    respond
      .mockResolvedValueOnce(reserve)
      .mockResolvedValueOnce(text('¿Te ayudo con algo más?'));

    await say('quiero turno el jueves a las 10');

    expect(actionFetch).toHaveBeenCalledTimes(1);
    const [url, init] = actionFetch.mock.calls[0]!;
    expect(url).toBe(booking.url);
    const body = init!.body as string;
    const headers = init!.headers as Record<string, string>;
    const conversation = await prisma.conversation.findFirstOrThrow();
    const inbound = await prisma.message.findFirstOrThrow({
      where: { author: 'USER' },
    });
    const key = `${inbound.id}:reservar_turno:1`;
    expect(JSON.parse(body)).toEqual({
      idempotencyKey: key,
      action: 'reservar_turno',
      businessId,
      conversationId: conversation.id,
      contact: { waId: USER, name: 'Juan' },
      arguments: { dia: 'jueves', hora: '10:00' },
    });
    expect(headers['X-Bottega-Idempotency-Key']).toBe(key);
    const signed = createHmac('sha256', secret)
      .update(`${headers['X-Bottega-Timestamp']}.${body}`)
      .digest('hex');
    expect(headers['X-Bottega-Signature']).toBe(`sha256=${signed}`);

    expect(toolResults(request(1))).toEqual([
      expect.objectContaining({
        ok: true,
        data: { turno: 'jueves 10:00' },
        reply: 'Te reservé el jueves a las 10.',
      }),
    ]);
    expect(sent()).toEqual([
      'Te reservé el jueves a las 10.',
      '¿Te ayudo con algo más?',
    ]);
    expect(await prisma.agentActionCall.findFirstOrThrow()).toMatchObject({
      idempotencyKey: key,
      status: 'SUCCEEDED',
      responseStatus: 200,
      conversationId: conversation.id,
    });
  });

  it('never calls it with invalid arguments: the model gets the error', async () => {
    respond
      .mockResolvedValueOnce(
        tool('reservar_turno', { dia: 'jueves', hora: '10:00 de la mañana' }),
      )
      .mockResolvedValueOnce(text('¿A qué hora querés?'));

    await say('quiero turno el jueves');

    expect(actionFetch).not.toHaveBeenCalled();
    expect(toolResults(request(1))).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
    expect(sent()).toEqual(['¿A qué hora querés?']);
    expect(await prisma.agentActionCall.count()).toBe(0);
  });

  it('a retried job never calls an effect twice: the first answer is replayed', async () => {
    respond
      .mockResolvedValueOnce(reserve)
      .mockRejectedValueOnce(new AiProviderError('openai_http_503', true));

    await say('quiero turno el jueves a las 10');

    expect(actionFetch).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { status: 'PENDING' },
    });
    expect(job.attempts).toBe(1);

    respond
      .mockResolvedValueOnce(reserve)
      .mockResolvedValueOnce(text('Listo.'));
    await makeRunnable();
    await worker.drain();

    expect(actionFetch).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(['Te reservé el jueves a las 10.', 'Listo.']);
    expect(await prisma.agentActionCall.count()).toBe(1);
    expect(
      await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });

  it('never calls an effect again when an earlier attempt never got its answer (the worker died mid-call)', async () => {
    await conversations.recordInbound({
      ...textEvent(`wamid.in.${(seq += 1)}`, USER, 'turno jueves 10'),
      profileName: 'Juan',
    });
    const inbound = await prisma.message.findFirstOrThrow({
      where: { author: 'USER' },
    });
    const action = await prisma.agentAction.findFirstOrThrow();
    // What a dead worker leaves: the call recorded, never answered.
    await prisma.agentActionCall.create({
      data: {
        businessId,
        actionId: action.id,
        idempotencyKey: `${inbound.id}:reservar_turno:1`,
      },
    });
    respond.mockResolvedValueOnce(reserve);

    await worker.drain();

    expect(actionFetch).not.toHaveBeenCalled();
    expect(sent()).toEqual([ACTION_FAILED_REPLY]);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('an error, a timeout or an invalid answer gives the fixed text and offers a person', async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.resolve(new Response('boom', { status: 500 })),
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      () => Promise.resolve(new Response('no es json', { status: 200 })),
      () => Promise.resolve(Response.json({ reply: 42 })),
      () => Promise.resolve(Response.json({ data: 'x'.repeat(9000) })),
    ];
    for (const failure of failures) {
      actionFetch.mockImplementationOnce(failure);
      respond.mockResolvedValueOnce(reserve);
      sendText.mockClear();

      await say('quiero turno el jueves a las 10');

      expect(sent()).toEqual([ACTION_FAILED_REPLY]);
    }
    expect(ACTION_FAILED_REPLY).toContain('No pude consultarlo ahora');
    expect(ACTION_FAILED_REPLY).toContain('humano');
    expect(
      (await prisma.agentActionCall.findMany({ orderBy: { createdAt: 'asc' } }))
        .map((c) => c.error),
    ).toEqual([
      'http_500',
      'timeout',
      'invalid_response',
      'invalid_response',
      'response_too_large',
    ]);
  });

  it('never calls an action whose host resolves to a private address', async () => {
    const resolve = vi.fn(() =>
      Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    );
    const connect = vi.fn();
    actionFetch.mockImplementationOnce(
      createSafeFetch({ maxResponseBytes: 8192 }, { resolve, request: connect }),
    );
    respond.mockResolvedValueOnce(reserve);

    await say('quiero turno el jueves a las 10');

    expect(connect).not.toHaveBeenCalled();
    expect(sent()).toEqual([ACTION_FAILED_REPLY]);
    expect(await prisma.agentActionCall.findFirstOrThrow()).toMatchObject({
      status: 'FAILED',
      error: 'blocked_address',
    });
  });

  it('a query action is asked again on a retried job (it only reads)', async () => {
    await prisma.agentAction.updateMany({ data: { kind: 'QUERY' } });
    respond
      .mockResolvedValueOnce(reserve)
      .mockRejectedValueOnce(new AiProviderError('openai_http_503', true));
    await say('¿hay turno el jueves a las 10?');

    respond
      .mockResolvedValueOnce(reserve)
      .mockResolvedValueOnce(text('Sí, hay.'));
    await makeRunnable();
    await worker.drain();

    expect(actionFetch).toHaveBeenCalledTimes(2);
    expect(await prisma.agentActionCall.findFirstOrThrow()).toMatchObject({
      status: 'SUCCEEDED',
      result: null,
    });
  });
});
