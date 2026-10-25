import { NotFoundException } from '@nestjs/common';
import type { BusinessAccess } from '../../src/auth/business-access.guard.js';
import type { SessionUser } from '../../src/auth/auth.service.js';
import { PasswordHasher } from '../../src/auth/password-hasher.js';
import { UsersService } from '../../src/auth/users.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { InboxQueriesService } from '../../src/inbox/inbox-queries.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import {
  connectPrisma,
  createLine,
  DEFAULT_PHONE_NUMBER_ID,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

describe('Inbox reads (integration)', () => {
  const config = testConfig();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let queries: InboxQueriesService;
  let businessId: string;
  let lineId: string;
  let access: BusinessAccess;
  let ana: SessionUser;
  let seq = 0;

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    queries = new InboxQueriesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    const business = await prisma.business.findUniqueOrThrow({
      where: { slug: 'botsuite46' },
      include: { lines: true },
    });
    businessId = business.id;
    lineId = business.lines[0]!.id;
    access = { businessId, role: 'OWNER' };
    ana = {
      ...(
        await new UsersService(prisma, new PasswordHasher()).addToBusiness(
          businessId,
          {
            email: 'ana@example.com',
            name: 'Ana',
            password: 'una clave larga',
            role: 'OWNER',
          },
        )
      ).user,
      mustChangePassword: false,
    };
  });

  const inbound = (from: string, text = 'hola', profileName?: string) =>
    conversations.recordInbound({
      ...textEvent(`wamid.in.${(seq += 1)}`, from, text),
      timestamp: new Date(),
      ...(profileName ? { profileName } : {}),
    });
  const idOf = async (waId: string) =>
    (
      await prisma.conversation.findFirstOrThrow({
        where: { contact: { waId } },
      })
    ).id;

  /** n conversations of the default line in one statement (same txid). */
  const bulk = (n: number) => prisma.$executeRaw`
    WITH c AS (
      INSERT INTO contact (id, business_id, wa_id, created_at, updated_at)
      SELECT gen_random_uuid(), ${businessId}::uuid, '5492' || lpad(g::text, 9, '0'), now(), now()
      FROM generate_series(1, ${n}) AS g
      RETURNING id, wa_id
    )
    INSERT INTO conversation (id, line_id, contact_id, mode, paused,
      last_message_at, created_at, updated_at)
    SELECT gen_random_uuid(), ${lineId}::uuid, c.id, 'COMMERCIAL', false,
      now() - (right(c.wa_id, 4)::int * interval '1 second'), now(), now()
    FROM c`;

  describe('list', () => {
    it('splits conversations into the four views', async () => {
      for (const n of ['1', '2', '3', '4', '5']) {
        await inbound(`549110000000${n}`);
      }
      const [mine, other, pending, resolved] = await Promise.all(
        [
          '5491100000001',
          '5491100000002',
          '5491100000003',
          '5491100000004',
        ].map(idOf),
      );
      const beto = (
        await new UsersService(prisma, new PasswordHasher()).addToBusiness(
          businessId,
          {
            email: 'beto@example.com',
            name: 'Beto',
            password: 'una clave larga',
            role: 'AGENT',
          },
        )
      ).user;
      await prisma.conversation.update({
        where: { id: mine },
        data: { assignedToId: ana.id },
      });
      await prisma.conversation.update({
        where: { id: other },
        data: { assignedToId: beto.id },
      });
      await prisma.conversation.update({
        where: { id: pending },
        data: { status: 'PENDING' },
      });
      await prisma.conversation.update({
        where: { id: resolved },
        data: { status: 'RESOLVED' },
      });

      const ids = async (
        view: 'mine' | 'unassigned' | 'pending' | 'resolved',
      ) =>
        (await queries.list(access, ana, { view })).conversations.map(
          (c) => c.id,
        );

      expect(await ids('mine')).toEqual([mine]);
      expect(await ids('unassigned')).toEqual([await idOf('5491100000005')]);
      expect(await ids('pending')).toEqual([pending]);
      expect(await ids('resolved')).toEqual([resolved]);
    });

    it('returns what the list needs, newest first, without the admin data', async () => {
      await inbound('5491100000001', 'primero', 'Ana Cliente');
      await inbound('5491100000002', 'segundo');

      const { conversations: rows } = await queries.list(access, ana, {
        view: 'unassigned',
      });

      expect(rows.map((r) => r.lastMessagePreview)).toEqual([
        'segundo',
        'primero',
      ]);
      expect(rows[1]).toEqual({
        id: expect.any(String) as unknown,
        lineId,
        contact: {
          id: expect.any(String) as unknown,
          waId: '5491100000001',
          name: 'Ana Cliente',
        },
        mode: 'COMMERCIAL',
        status: 'OPEN',
        assignedTo: null,
        paused: false,
        unreadCount: 1,
        lastMessageAt: expect.any(Date) as unknown,
        lastMessagePreview: 'primero',
        windowExpiresAt: expect.any(Date) as unknown,
        version: expect.any(Number) as unknown,
      });
    });

    it('pages 30 at a time by (lastMessageAt, id), without repeats', async () => {
      await bulk(35);

      const first = await queries.list(access, ana, { view: 'unassigned' });
      const second = await queries.list(access, ana, {
        view: 'unassigned',
        cursor: first.nextCursor!,
      });

      expect(first.conversations).toHaveLength(30);
      expect(second.conversations).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      const all = [...first.conversations, ...second.conversations];
      expect(new Set(all.map((c) => c.id)).size).toBe(35);
      const times = all.map((c) => c.lastMessageAt!.getTime());
      expect(times).toEqual([...times].sort((x, y) => y - x));
    });

    it('lists conversations without lastMessageAt (written by the previous release) last', async () => {
      await bulk(31);
      await inbound('5491100000001');
      await prisma.conversation.updateMany({
        where: { contact: { waId: '5491100000001' } },
        data: { lastMessageAt: null },
      });

      const first = await queries.list(access, ana, { view: 'unassigned' });
      const second = await queries.list(access, ana, {
        view: 'unassigned',
        cursor: first.nextCursor!,
      });

      const all = [...first.conversations, ...second.conversations];
      expect(all).toHaveLength(32);
      expect(new Set(all.map((c) => c.id)).size).toBe(32);
      expect(all.at(-1)?.contact.waId).toBe('5491100000001');
      expect(second.nextCursor).toBeNull();
    });

    it('filters by contact name or number, and by line of the business only', async () => {
      await inbound('5491100000001', 'hola', 'Ana Cliente');
      await inbound('5491177770002', 'hola', 'Beto');

      const search = async (q: string) =>
        (
          await queries.list(access, ana, { view: 'unassigned', q })
        ).conversations.map((c) => c.contact.waId);
      expect(await search('ana')).toEqual(['5491100000001']);
      expect(await search('7777')).toEqual(['5491177770002']);
      expect(
        (await queries.list(access, ana, { view: 'unassigned', lineId }))
          .conversations,
      ).toHaveLength(2);

      const other = await createLine(prisma, {
        slug: 'lola',
        phoneNumberId: '222',
      });
      await expect(
        queries.list(access, ana, { view: 'unassigned', lineId: other.lineId }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a malformed cursor', async () => {
      await expect(
        queries.list(access, ana, { view: 'mine', cursor: 'not-a-cursor' }),
      ).rejects.toThrow(/cursor/i);
    });
  });

  describe('changes', () => {
    it('returns everything the first time, then nothing new', async () => {
      await inbound('5491100000001');
      await inbound('5491100000002');

      const first = await queries.changes(access, undefined);
      const again = await queries.changes(access, first.cursor);

      expect(first.conversations).toHaveLength(2);
      expect(first.hasMore).toBe(false);
      expect(again.conversations).toEqual([]);
    });

    it('a read tick shows up in /changes', async () => {
      await prisma.message.deleteMany();
      await inbound('5491100000001');
      const id = await idOf('5491100000001');
      const context = await prisma.conversation.findUniqueOrThrow({
        where: { id },
      });
      await prisma.message.create({
        data: {
          conversationId: id,
          contextId: context.activeContextId,
          direction: 'OUTBOUND',
          type: 'TEXT',
          content: 'respuesta',
          status: 'SENT',
          author: 'BOT',
          waMessageId: 'wamid.out.tick',
        },
      });
      const { cursor } = await queries.changes(access, undefined);

      await conversations.applyStatus({
        kind: 'status',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        waMessageId: 'wamid.out.tick',
        status: 'read',
        recipientId: '5491100000001',
        timestamp: new Date(),
      });
      const next = await queries.changes(access, cursor);

      expect(next.conversations.map((c) => c.id)).toEqual([id]);
    });

    it('250 changes in a row are read completely in two calls', async () => {
      await bulk(250);

      const first = await queries.changes(access, undefined);
      const second = await queries.changes(access, first.cursor);

      expect(first.conversations).toHaveLength(200);
      expect(first.hasMore).toBe(true);
      expect(second.conversations).toHaveLength(50);
      expect(second.hasMore).toBe(false);
      const ids = [...first.conversations, ...second.conversations].map(
        (c) => c.id,
      );
      expect(new Set(ids).size).toBe(250);
    });

    it('a transaction that started first and commits later is not lost', async () => {
      await inbound('5491100000001');
      await inbound('5491100000002');
      const [early, late] = await Promise.all(
        ['5491100000001', '5491100000002'].map(idOf),
      );
      const { cursor: start } = await queries.changes(access, undefined);

      let releaseEarly!: () => void;
      const hold = new Promise<void>((resolve) => (releaseEarly = resolve));
      let earlyStarted!: () => void;
      const started = new Promise<void>((resolve) => (earlyStarted = resolve));
      // The early transaction writes first (lower txid) and commits last.
      const earlyTx = prisma.$transaction(
        async (tx) => {
          await tx.conversation.update({
            where: { id: early },
            data: { paused: true },
          });
          earlyStarted();
          await hold;
        },
        { timeout: 10_000 },
      );
      await started;
      await prisma.conversation.update({
        where: { id: late },
        data: { paused: true },
      });

      const middle = await queries.changes(access, start);
      expect(middle.conversations.map((c) => c.id)).toEqual([late]);

      releaseEarly();
      await earlyTx;
      const after = await queries.changes(access, middle.cursor);

      expect(after.conversations.map((c) => c.id)).toContain(early);
    });

    it('a page cut while an older transaction is still open does not lose it', async () => {
      await inbound('5491100000001');
      const early = await idOf('5491100000001');
      await bulk(205);
      const { cursor: start } = await queries.changes(access, undefined);

      let releaseEarly!: () => void;
      const hold = new Promise<void>((resolve) => (releaseEarly = resolve));
      let earlyStarted!: () => void;
      const started = new Promise<void>((resolve) => (earlyStarted = resolve));
      const earlyTx = prisma.$transaction(
        async (tx) => {
          await tx.conversation.update({
            where: { id: early },
            data: { paused: true },
          });
          earlyStarted();
          await hold;
        },
        { timeout: 10_000 },
      );
      await started;
      // A burst after the early write: one transaction, more than a page.
      await prisma.$executeRaw`UPDATE conversation SET unread_count = 7 WHERE id <> ${early}::uuid`;

      const seen = new Set<string>();
      let page = await queries.changes(access, start);
      expect(page.hasMore).toBe(true);
      page.conversations.forEach((c) => seen.add(c.id));
      releaseEarly();
      await earlyTx;
      for (let i = 0; i < 5; i += 1) {
        page = await queries.changes(access, page.cursor);
        page.conversations.forEach((c) => seen.add(c.id));
      }

      expect(seen.has(early)).toBe(true);
      expect(seen.size).toBe(206);
    });

    it('only returns conversations of the business', async () => {
      const other = await createLine(prisma, {
        slug: 'lola',
        phoneNumberId: '222',
      });
      await conversations.recordInbound(
        {
          ...textEvent('wamid.lola', '5491100000009'),
          phoneNumberId: '222',
          timestamp: new Date(),
        },
        { lineId: other.lineId, businessId: other.businessId },
      );
      await inbound('5491100000001');

      const { conversations: rows } = await queries.changes(access, undefined);

      expect(rows.map((c) => c.lineId)).toEqual([lineId]);
    });
  });

  describe('messages', () => {
    const seedMessages = async (n: number) => {
      await inbound('5491100000001', 'm0');
      const id = await idOf('5491100000001');
      const { activeContextId } = await prisma.conversation.findUniqueOrThrow({
        where: { id },
      });
      await prisma.message.createMany({
        data: Array.from({ length: n - 1 }, (_, i) => ({
          conversationId: id,
          contextId: activeContextId,
          direction: 'OUTBOUND' as const,
          type: 'TEXT' as const,
          content: `m${i + 1}`,
          status: 'SENT' as const,
          author: 'BOT' as const,
        })),
      });
      return id;
    };

    it('pages 50 by seq: the latest by default, older with before, newer with after', async () => {
      const id = await seedMessages(120);

      const latest = await queries.messages(access, id, {});
      expect(latest.messages).toHaveLength(50);
      expect(latest.messages.at(-1)?.content).toBe('m119');
      expect(latest.hasMore).toBe(true);
      const seqs = latest.messages.map((m) => BigInt(m.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)));

      const older = await queries.messages(access, id, {
        before: latest.messages[0]!.seq,
      });
      expect(older.messages.at(-1)?.content).toBe('m69');
      expect(older.messages[0]?.content).toBe('m20');

      const newer = await queries.messages(access, id, {
        after: older.messages.at(-1)!.seq,
      });
      expect(newer.messages[0]?.content).toBe('m70');
      expect(newer.messages).toHaveLength(50);
    });

    it('404s for a conversation of another business', async () => {
      const id = await seedMessages(2);
      const other = await createLine(prisma, {
        slug: 'lola',
        phoneNumberId: '222',
      });

      await expect(
        queries.messages(
          { businessId: other.businessId, role: 'OWNER' },
          id,
          {},
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('lines lists only the lines of the business', async () => {
    await createLine(prisma, { slug: 'lola', phoneNumberId: '222' });

    expect(await queries.lines(access)).toEqual({
      lines: [
        {
          id: lineId,
          phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
          displayPhone: null,
          active: true,
        },
      ],
    });
  });
});
