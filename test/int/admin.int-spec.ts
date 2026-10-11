import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/admin/admin.service.js';
import { EchoReplyGenerator } from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContextService } from '../../src/conversations/context.service.js';
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
const HOUR = 60 * 60 * 1000;

describe('Admin operations (integration)', () => {
  const config = testConfig();
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let worker: BotWorker;
  let admin: AdminService;
  let seq = 0;

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
    sendText.mockImplementation(() =>
      Promise.resolve({ kind: 'sent', waMessageId: `wamid.out.${(seq += 1)}` }),
    );
    const bot = buildBotService(prisma, { sendText }, new EchoReplyGenerator());
    worker = new BotWorker(config, new QueueService(prisma, config), bot);
    admin = new AdminService(prisma, new ContextService(prisma), { sendText });
  });

  /** Records one user text and processes it. Returns the conversation id. */
  const say = async (text: string, from = USER) => {
    const result = await conversations.recordInbound(
      textEvent(`wamid.in.${(seq += 1)}`, from, text),
    );
    await worker.drain();
    return result.conversationId;
  };

  /** Moves the last inbound time so the 24h window is open or closed. */
  const setLastInbound = (id: string, hoursAgo: number) =>
    prisma.conversation.update({
      where: { id },
      data: { lastInboundAt: new Date(Date.now() - hoursAgo * HOUR) },
    });

  const handoffs = (conversationId: string) =>
    prisma.handoffRequest.findMany({ where: { conversationId } });

  it('pause and resume are idempotent and manage the handoff', async () => {
    const id = await say('hola');

    const first = await admin.pause(id);
    const second = await admin.pause(id);
    expect(first).toMatchObject({ wasPaused: false, handoffCreated: true });
    expect(second).toMatchObject({
      wasPaused: true,
      handoffCreated: false,
      handoffId: first.handoffId,
    });
    expect(await handoffs(id)).toEqual([
      expect.objectContaining({ status: 'OPEN', reason: 'admin' }),
    ]);

    const resumed = await admin.resume(id, true);
    const again = await admin.resume(id, true);
    expect(resumed).toMatchObject({ wasPaused: true, resolvedHandoffs: 1 });
    expect(again).toMatchObject({ wasPaused: false, resolvedHandoffs: 0 });
    const [handoff] = await handoffs(id);
    expect(handoff).toMatchObject({ status: 'RESOLVED' });
    expect(handoff?.resolvedAt).toBeInstanceOf(Date);
    expect(
      await prisma.conversation.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ paused: false, pausedAt: null });
  });

  it('does not open a second handoff when the user already asked for one', async () => {
    const id = await say('humano');

    const result = await admin.pause(id);

    expect(result).toMatchObject({ wasPaused: true, handoffCreated: false });
    expect(await handoffs(id)).toHaveLength(1);
  });

  it('can resume without resolving handoffs', async () => {
    const id = await say('hola');
    await admin.pause(id);

    await admin.resume(id, false);

    expect(await handoffs(id)).toEqual([
      expect.objectContaining({ status: 'OPEN' }),
    ]);
  });

  it('stores messages while paused without replying, and answers again after resume', async () => {
    const id = await say('hola');
    await admin.pause(id);
    sendText.mockClear();

    await say('¿hay alguien?');
    await say('demo'); // commands are not run while paused either

    expect(sendText).not.toHaveBeenCalled();
    const paused = await prisma.conversation.findUniqueOrThrow({
      where: { id },
    });
    expect(paused.mode).toBe('COMMERCIAL');
    const stored = await prisma.message.findMany({
      where: { conversationId: id, direction: 'INBOUND' },
    });
    expect(stored.map((m) => m.status)).toEqual([
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
    ]);

    await admin.resume(id, true);
    await say('volví');

    // Only the new message is answered; paused ones are not retro-answered.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).toContain('volví');
  });

  it('sends a human reply inside the 24h window and stores it as HUMAN', async () => {
    const id = await say('hola');
    await setLastInbound(id, 1);
    await admin.pause(id);
    sendText.mockClear();

    const result = await admin.sendHumanReply(id, 'Hola, soy del equipo');

    expect(result).toMatchObject({ outcome: 'sent' });
    expect(sendText).toHaveBeenCalledWith(USER, 'Hola, soy del equipo');
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id },
    });
    const message = await prisma.message.findUniqueOrThrow({
      where: { id: result.messageId },
    });
    expect(message).toMatchObject({
      direction: 'OUTBOUND',
      author: 'HUMAN',
      status: 'SENT',
      contextId: conversation.activeContextId,
    });
    expect(message.waMessageId).toMatch(/^wamid\.out\./);
    // A human reply does not unpause the bot.
    expect(conversation.paused).toBe(true);
  });

  it('refuses a human reply outside the 24h window and sends nothing', async () => {
    const id = await say('hola');
    await setLastInbound(id, 25);
    sendText.mockClear();

    await expect(admin.sendHumanReply(id, 'Hola')).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(sendText).not.toHaveBeenCalled();
    expect(await prisma.message.count({ where: { author: 'HUMAN' } })).toBe(0);
  });

  it('records an uncertain send and never resends it', async () => {
    const id = await say('hola');
    await setLastInbound(id, 1);
    sendText.mockReset();
    sendText.mockResolvedValue({ kind: 'uncertain', reason: 'timeout' });

    const result = await admin.sendHumanReply(id, 'Hola', 'retry-me');
    const repeat = await admin.sendHumanReply(id, 'Hola', 'retry-me');

    expect(result).toMatchObject({ outcome: 'uncertain' });
    expect(repeat).toMatchObject({
      outcome: 'replayed',
      messageId: result.messageId,
      status: 'UNCERTAIN',
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    const attention = await admin.listAttentionMessages({
      status: 'UNCERTAIN',
      limit: 50,
    });
    expect(attention.map((m) => m.id)).toEqual([result.messageId]);
  });

  it('records a rejected send as FAILED with the Meta code', async () => {
    const id = await say('hola');
    await setLastInbound(id, 1);
    sendText.mockResolvedValueOnce({
      kind: 'rejected',
      code: 131047,
      httpStatus: 400,
      message: 'Re-engagement message',
      retryable: false,
    });

    const result = await admin.sendHumanReply(id, 'Hola');

    expect(result).toMatchObject({ outcome: 'rejected', code: '131047' });
    const failed = await admin.listAttentionMessages({
      status: 'FAILED',
      limit: 50,
    });
    expect(failed).toEqual([
      expect.objectContaining({ errorCode: '131047', author: 'HUMAN' }),
    ]);
  });

  it('prevents a double send with the same Idempotency-Key', async () => {
    const id = await say('hola');
    await setLastInbound(id, 1);
    sendText.mockClear();

    const first = await admin.sendHumanReply(id, 'Hola', 'k-1');
    const second = await admin.sendHumanReply(id, 'Hola', 'k-1');

    expect(first.outcome).toBe('sent');
    expect(second).toMatchObject({
      outcome: 'replayed',
      messageId: first.messageId,
      status: 'SENT',
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('describes a conversation by id and by wa id', async () => {
    const id = await say('hola');
    await setLastInbound(id, 2);
    await admin.pause(id);

    const byId = await admin.getConversation(id, 50);
    const byWa = await admin.getConversationByWaId(USER, 1);

    expect(byId.conversation).toMatchObject({ id, waId: USER, paused: true });
    expect(byId.serviceWindow.open).toBe(true);
    expect(byId.openHandoffs).toHaveLength(1);
    expect(byId.messages.map((m) => [m.direction, m.author])).toEqual([
      ['INBOUND', 'USER'],
      ['OUTBOUND', 'BOT'],
    ]);
    expect(byWa.messages).toHaveLength(1);
    expect(byWa.messages[0]?.direction).toBe('OUTBOUND');
    await expect(
      admin.getConversation('00000000-0000-4000-8000-000000000000', 50),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists leads and handoffs filtered by status, newest first', async () => {
    const a = await say('hola', '5491100000001');
    const b = await say('hola', '5491100000002');
    // Explicit times: createdAt has ms resolution and could tie.
    await prisma.lead.create({
      data: {
        conversationId: a,
        name: 'Ana',
        createdAt: new Date(Date.now() - HOUR),
      },
    });
    await prisma.lead.create({
      data: { conversationId: b, name: 'Beto', status: 'QUALIFIED' },
    });
    await admin.pause(a);
    await admin.pause(b);
    await admin.resume(a, true);

    const qualified = await admin.listLeads({ status: 'QUALIFIED', limit: 50 });
    const allLeads = await admin.listLeads({ limit: 50 });
    const open = await admin.listHandoffs({ status: 'OPEN', limit: 50 });
    const limited = await admin.listHandoffs({ limit: 1 });

    expect(qualified.map((l) => l.name)).toEqual(['Beto']);
    expect(qualified[0]?.conversation.waId).toBe('5491100000002');
    expect(allLeads.map((l) => l.name)).toEqual(['Beto', 'Ana']);
    expect(open.map((h) => h.conversationId)).toEqual([b]);
    expect(limited).toHaveLength(1);
  });
});
