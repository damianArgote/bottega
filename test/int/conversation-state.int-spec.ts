import { EchoReplyGenerator } from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import {
  buildBotService,
  connectPrisma,
  DEFAULT_PHONE_NUMBER_ID,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';

describe('Conversation inbox state (integration)', () => {
  const config = testConfig();
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
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
    const bot = buildBotService(prisma, { sendText }, new EchoReplyGenerator());
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      bot,
      new QueueSignal(),
    );
  });

  const inbound = (text: string, at = '2026-10-25T12:00:00Z') =>
    conversations.recordInbound({
      ...textEvent(`wamid.in.${(seq += 1)}`, USER, text),
      timestamp: new Date(at),
    });

  const conversation = () => prisma.conversation.findFirstOrThrow();
  const tracking = async () => {
    const [row] = await prisma.$queryRaw<
      { changeTxid: bigint; version: number }[]
    >`SELECT change_txid AS "changeTxid", version FROM conversation`;
    return row!;
  };

  describe('change tracking trigger', () => {
    it('stamps every insert and update with the transaction id and raises version', async () => {
      await inbound('hola');
      const first = await tracking();
      expect(first.changeTxid).toBeGreaterThan(0n);

      await prisma.conversation.updateMany({ data: { paused: true } });
      const second = await tracking();

      expect(second.version).toBe(first.version + 1);
      expect(second.changeTxid).toBeGreaterThan(first.changeTxid);
    });

    it('writes from raw SQL are tracked too', async () => {
      await inbound('hola');
      const before = await tracking();

      await prisma.$executeRaw`UPDATE conversation SET paused = true`;

      expect((await tracking()).version).toBe(before.version + 1);
    });
  });

  describe('inbound', () => {
    it('counts unread, keeps the preview and last message time, and opens the window 24 h', async () => {
      await inbound('hola');
      await inbound('quiero info de los planes', '2026-10-25T12:05:00Z');

      expect(await conversation()).toMatchObject({
        status: 'OPEN',
        assignedToId: null,
        unreadCount: 2,
        lastMessagePreview: 'quiero info de los planes',
        windowExpiresAt: new Date('2026-10-26T12:05:00Z'),
      });
      expect((await conversation()).lastMessageAt).not.toBeNull();
    });

    it('never moves the window back for a late older message', async () => {
      await inbound('nuevo', '2026-10-25T12:00:00Z');
      await inbound('viejo', '2026-10-24T08:00:00Z');

      expect((await conversation()).windowExpiresAt).toEqual(
        new Date('2026-10-26T12:00:00Z'),
      );
    });

    it('a duplicate delivery adds no unread and no message', async () => {
      const event = {
        ...textEvent('wamid.dup', USER, 'hola'),
        timestamp: new Date(),
      };
      await conversations.recordInbound(event);

      await conversations.recordInbound(event);

      // The conversation upsert runs (and locks the row) before the message
      // insert finds the duplicate, so version may rise: /changes allows
      // repeats. The inbox state itself does not change.
      expect((await conversation()).unreadCount).toBe(1);
      expect(await prisma.message.count()).toBe(1);
    });

    it('reopens a resolved conversation, unassigned', async () => {
      await inbound('hola');
      await prisma.conversation.updateMany({ data: { status: 'RESOLVED' } });

      await inbound('volví');

      expect(await conversation()).toMatchObject({
        status: 'OPEN',
        assignedToId: null,
      });
    });
  });

  describe('outbound and ticks', () => {
    it("the bot's reply updates the preview, and sending and the read tick bump the version", async () => {
      await inbound('hola');
      await worker.drain();

      const afterReply = await conversation();
      expect(afterReply.lastMessagePreview).toContain('hola');
      expect(afterReply.unreadCount).toBe(1);
      const sentVersion = (await tracking()).version;

      const reply = await prisma.message.findFirstOrThrow({
        where: { direction: 'OUTBOUND' },
      });
      await conversations.applyStatus({
        kind: 'status',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        waMessageId: reply.waMessageId!,
        status: 'read',
        recipientId: USER,
        timestamp: new Date(),
      });

      expect((await tracking()).version).toBeGreaterThan(sentVersion);
    });

    it("Meta's 131047 on a bot reply moves the window to now", async () => {
      sendText.mockResolvedValue({
        kind: 'rejected',
        code: 131047,
        httpStatus: 400,
        message: 'Re-engagement message',
        retryable: false,
      });
      await inbound('hola');
      const before = Date.now();

      await worker.drain();

      const { windowExpiresAt } = await conversation();
      expect(windowExpiresAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(windowExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('an ignored tick does not touch the conversation', async () => {
      await inbound('hola');
      const before = await tracking();

      await conversations.applyStatus({
        kind: 'status',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        waMessageId: 'wamid.unknown',
        status: 'read',
        recipientId: USER,
        timestamp: new Date(),
      });

      expect((await tracking()).version).toBe(before.version);
    });
  });

  it('messages get an increasing seq in insertion order', async () => {
    await inbound('uno');
    await inbound('dos');
    await worker.drain();

    const rows = await prisma.message.findMany({ orderBy: { seq: 'asc' } });
    const seqs = rows.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(rows.length);
    expect(rows.slice(0, 2).map((m) => m.content)).toEqual(['uno', 'dos']);
  });
});
