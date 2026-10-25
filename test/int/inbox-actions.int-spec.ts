import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { BusinessAccess } from '../../src/auth/business-access.guard.js';
import type { SessionUser } from '../../src/auth/auth.service.js';
import { PasswordHasher } from '../../src/auth/password-hasher.js';
import { UsersService } from '../../src/auth/users.service.js';
import { EchoReplyGenerator } from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { ConversationActionsService } from '../../src/inbox/conversation-actions.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import {
  buildBotService,
  connectPrisma,
  createLine,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';

describe('Inbox conversation actions (integration)', () => {
  const config = testConfig();
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let actions: ConversationActionsService;
  let worker: BotWorker;
  let seq = 0;
  let businessId: string;
  let ana: SessionUser;
  let beto: SessionUser;
  let anaAccess: BusinessAccess;
  let betoAccess: BusinessAccess;

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    actions = new ConversationActionsService(prisma);
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
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      buildBotService(prisma, { sendText }, new EchoReplyGenerator()),
      new QueueSignal(),
    );
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    const users = new UsersService(prisma, new PasswordHasher());
    const add = async (email: string, name: string, role: 'OWNER' | 'AGENT') =>
      (
        await users.addToBusiness(businessId, {
          email,
          name,
          password: 'una clave larga',
          role,
        })
      ).user;
    ana = await add('ana@example.com', 'Ana', 'AGENT');
    beto = await add('beto@example.com', 'Beto', 'OWNER');
    anaAccess = { businessId, role: 'AGENT' };
    betoAccess = { businessId, role: 'OWNER' };
  });

  const say = async (text: string) => {
    await conversations.recordInbound({
      ...textEvent(`wamid.in.${(seq += 1)}`, USER, text),
      timestamp: new Date(),
    });
    await worker.drain();
  };
  const conversation = () => prisma.conversation.findFirstOrThrow();
  const systemMessages = async () =>
    (
      await prisma.message.findMany({
        where: { type: 'SYSTEM' },
        orderBy: { seq: 'asc' },
      })
    ).map((m) => m.content);

  it('two operators take the same conversation at once: exactly one wins', async () => {
    await say('hola');
    const { id } = await conversation();

    const results = await Promise.allSettled([
      actions.take(anaAccess, ana, id, { force: false }),
      actions.take(betoAccess, beto, id, { force: false }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    const winner = (
      won[0] as PromiseFulfilledResult<{ assignedTo: { id: string } }>
    ).value.assignedTo.id;
    expect((await conversation()).assignedToId).toBe(winner);
    expect(await systemMessages()).toHaveLength(1);
  });

  it('with the conversation taken, an inbound message gets no bot reply and the job ends skipped', async () => {
    await say('hola');
    sendText.mockClear();
    const { id } = await conversation();
    await actions.take(anaAccess, ana, id, { force: false });

    await say('¿hay alguien?');

    expect(sendText).not.toHaveBeenCalled();
    const job = await prisma.processingJob.findFirstOrThrow({
      orderBy: { seq: 'desc' },
    });
    expect(job.status).toBe('SKIPPED');
    const inbound = await prisma.message.findFirstOrThrow({
      where: { content: '¿hay alguien?' },
    });
    expect(inbound.status).toBe('PROCESSED');
  });

  it('"devolver al bot" makes the next inbound message get a bot reply again', async () => {
    await say('hola');
    const { id } = await conversation();
    await actions.take(anaAccess, ana, id, { force: false });
    await say('sigo acá');
    sendText.mockClear();

    const view = await actions.handBack(anaAccess, ana, id);
    await say('otra pregunta');

    expect(view).toMatchObject({
      status: 'OPEN',
      assignedTo: null,
      paused: false,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('release keeps the bot quiet until someone hands it back', async () => {
    await say('hola');
    const { id } = await conversation();
    await actions.take(anaAccess, ana, id, { force: false });
    sendText.mockClear();

    await actions.release(anaAccess, ana, id);
    await say('¿me escuchan?');

    expect(await conversation()).toMatchObject({
      assignedToId: null,
      paused: true,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('taking one that someone else has: 409, unless an OWNER forces it; force is OWNER only', async () => {
    await say('hola');
    const { id } = await conversation();
    await actions.take(anaAccess, ana, id, { force: false });

    await expect(
      actions.take(betoAccess, beto, id, { force: false }),
    ).rejects.toThrow(ConflictException);
    await actions.take(betoAccess, beto, id, { force: true });
    expect((await conversation()).assignedToId).toBe(beto.id);

    await expect(
      actions.take(anaAccess, ana, id, { force: true }),
    ).rejects.toThrow(ForbiddenException);
    expect(await systemMessages()).toEqual([
      'Ana tomó la conversación',
      'Beto tomó la conversación (la tenía Ana)',
    ]);
  });

  it('only the assignee or an OWNER can release it', async () => {
    await say('hola');
    const { id } = await conversation();
    await actions.take(betoAccess, beto, id, { force: false });

    await expect(actions.release(anaAccess, ana, id)).rejects.toThrow(
      ConflictException,
    );
    await actions.release(betoAccess, beto, id);
  });

  it('resolve closes it and lets the bot answer the next message, which reopens it', async () => {
    await say('hola');
    const { id } = await conversation();
    await actions.take(anaAccess, ana, id, { force: false });

    expect(await actions.resolve(anaAccess, ana, id)).toMatchObject({
      status: 'RESOLVED',
      assignedTo: null,
      paused: false,
    });
    sendText.mockClear();
    await say('volví');

    expect(await conversation()).toMatchObject({ status: 'OPEN' });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await systemMessages()).toEqual([
      'Ana tomó la conversación',
      'Ana resolvió la conversación',
    ]);
  });

  it('hand back and resolve close the open handoff requests', async () => {
    await say('humano');
    const { id } = await conversation();
    await actions.take(anaAccess, ana, id, { force: false });

    await actions.handBack(anaAccess, ana, id);

    expect(
      await prisma.handoffRequest.findMany({ select: { status: true } }),
    ).toEqual([{ status: 'RESOLVED' }]);
    expect((await conversation()).pausedAt).toBeNull();

    await say('humano');
    await actions.resolve(anaAccess, ana, id);
    expect(
      await prisma.handoffRequest.count({ where: { status: 'OPEN' } }),
    ).toBe(0);
  });

  it('a bot handoff leaves it pending, unassigned and quiet, with a system message', async () => {
    await say('humano');

    expect(await conversation()).toMatchObject({
      status: 'PENDING',
      assignedToId: null,
      paused: true,
    });
    expect(await systemMessages()).toEqual([
      'Pasó a Pendientes: pidió hablar con una persona',
    ]);
  });

  it('system messages are never sent to WhatsApp', async () => {
    await say('hola');
    const { id } = await conversation();
    sendText.mockClear();

    await actions.take(anaAccess, ana, id, { force: false });
    await actions.handBack(anaAccess, ana, id);
    await say('hola de nuevo');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).not.toContain('tomó');
  });

  it('404s for a conversation of another business', async () => {
    const other = await createLine(prisma, {
      slug: 'lola',
      phoneNumberId: '222',
    });
    await conversations.recordInbound(
      {
        ...textEvent('wamid.lola', USER, 'hola'),
        phoneNumberId: '222',
        timestamp: new Date(),
      },
      { lineId: other.lineId, businessId: other.businessId },
    );
    const lola = await prisma.conversation.findFirstOrThrow({
      where: { lineId: other.lineId },
    });

    await expect(
      actions.take(anaAccess, ana, lola.id, { force: false }),
    ).rejects.toThrow(NotFoundException);
  });
});
