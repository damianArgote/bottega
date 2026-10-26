import { PasswordHasher } from '../../src/auth/password-hasher.js';
import { UsersService } from '../../src/auth/users.service.js';
import { ContextService } from '../../src/conversations/context.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { PushOutcome, PushSender } from '../../src/push/push-sender.js';
import { PushSubscriptionsService } from '../../src/push/push-subscriptions.service.js';
import { PushService } from '../../src/push/push.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import { connectPrisma, resetDb, testConfig, textEvent } from './helpers.js';

const VAPID = {
  // A throwaway pair, generated for these tests only.
  VAPID_PUBLIC_KEY:
    'BDWoHXwGd0A1EkmJifVYTn-LkoWyr7Vg38nBPQlPawo4WhgQY8qkSbl_mzslt4X7XlJpbO1EnPw6JVUsl7KRfdY',
  VAPID_PRIVATE_KEY: 'yPmYWYTyNgsNmDJWJwKd6DeTQ5JuM_IO5W7XSc9PYXw',
  VAPID_SUBJECT: 'mailto:hola@botsuite46.com',
};
const KEYS = { p256dh: 'BNcRdreA', auth: 'tBHItJI5' };

describe('Web Push jobs (integration)', () => {
  const config = testConfig(VAPID);
  const offConfig = testConfig({
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
  });
  const send = vi.fn<PushSender['send']>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let queue: QueueService;
  let push: PushService;
  let subscriptions: PushSubscriptionsService;
  let businessId: string;
  let olga: string;
  let ana: string;

  beforeAll(async () => {
    prisma = await connectPrisma();
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    queue = new QueueService(prisma, config);
    push = new PushService(prisma, config, { send });
    subscriptions = new PushSubscriptionsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    send.mockReset().mockResolvedValue({ kind: 'accepted' });
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    const users = new UsersService(prisma, new PasswordHasher());
    const add = async (email: string, role: 'OWNER' | 'AGENT') =>
      (
        await users.addToBusiness(businessId, {
          email,
          name: email.split('@')[0]!,
          password: 'una clave larga',
          role,
        })
      ).user.id;
    olga = await add('olga@example.com', 'OWNER');
    ana = await add('ana@example.com', 'AGENT');
    await subscriptions.save(olga, {
      endpoint: 'https://push.example.com/olga-phone',
      keys: KEYS,
    });
    await subscriptions.save(ana, {
      endpoint: 'https://push.example.com/ana-phone',
      keys: KEYS,
    });
    await subscriptions.save(ana, {
      endpoint: 'https://push.example.com/ana-laptop',
      keys: KEYS,
    });
  });

  const pushJobs = () =>
    prisma.processingJob.findMany({
      where: { type: 'PUSH_NOTIFICATION' },
      orderBy: { seq: 'asc' },
    });
  const endpointsSent = () =>
    send.mock.calls.map(([target]) => target.endpoint).sort();

  /** Records an inbound text and claims its push job. */
  const inboundPush = async (waMessageId: string, text = 'hola') => {
    await conversations.recordInbound(
      textEvent(waMessageId, '5491100000001', text),
    );
    const [job] = await pushJobs();
    await prisma.processingJob.updateMany({
      where: { type: 'INBOUND_MESSAGE' },
      data: { status: 'COMPLETED' },
    });
    const claimed = await queue.claimNext('w1');
    expect(claimed?.id).toBe(job!.id);
    return claimed as Extract<typeof claimed, { type: 'PUSH_NOTIFICATION' }>;
  };

  const setConversation = (data: {
    status?: 'OPEN' | 'PENDING';
    assignedToId?: string | null;
    paused?: boolean;
  }) => prisma.conversation.updateMany({ data });

  describe('enqueueing', () => {
    it('an inbound message enqueues its push with it, once', async () => {
      await conversations.recordInbound(textEvent('wamid.1'));
      await conversations.recordInbound(textEvent('wamid.1'));

      const message = await prisma.message.findUniqueOrThrow({
        where: { waMessageId: 'wamid.1' },
      });
      expect(await pushJobs()).toEqual([
        expect.objectContaining({
          pushReason: 'INBOUND',
          messageId: null,
          pushMessageId: message.id,
          conversationId: message.conversationId,
          status: 'PENDING',
        }),
      ]);
    });

    it('in the same transaction: if the push job fails, the message is not stored', async () => {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION test_reject_push() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'push rejected'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_reject_push BEFORE INSERT ON processing_job
        FOR EACH ROW WHEN (NEW.type = 'PUSH_NOTIFICATION')
        EXECUTE FUNCTION test_reject_push()`);
      try {
        await expect(
          conversations.recordInbound(textEvent('wamid.1')),
        ).rejects.toThrow();

        expect(await prisma.message.count()).toBe(0);
        expect(await prisma.processingJob.count()).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER test_reject_push ON processing_job',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION test_reject_push()');
      }
    });

    it('nothing is enqueued while push is not configured', async () => {
      await new ConversationsService(
        prisma,
        offConfig,
        new QueueSignal(),
      ).recordInbound(textEvent('wamid.1'));

      expect(await pushJobs()).toEqual([]);
      expect(await prisma.processingJob.count()).toBe(1);
    });

    it('a handoff enqueues a push without a message, in its transaction', async () => {
      await conversations.recordInbound(textEvent('wamid.1'));
      const { id } = await prisma.conversation.findFirstOrThrow();
      await prisma.processingJob.deleteMany();

      await new ContextService(prisma, config).requestHuman(id, 'reclamo');

      expect(await pushJobs()).toEqual([
        expect.objectContaining({
          pushReason: 'HANDOFF',
          messageId: null,
          pushMessageId: null,
          conversationId: id,
        }),
      ]);
    });
  });

  describe('sending', () => {
    it('an assigned conversation notifies only its person, on each of their browsers', async () => {
      const job = await inboundPush(
        'wamid.1',
        'Perfecto, ¿me pasás el link de pago?',
      );
      await setConversation({ assignedToId: ana });

      expect(await push.process(job)).toBe('done');

      expect(endpointsSent()).toEqual([
        'https://push.example.com/ana-laptop',
        'https://push.example.com/ana-phone',
      ]);
      const [target, payload, options] = send.mock.calls[0]!;
      expect(target.keys).toEqual(KEYS);
      const conversationId = job.conversationId;
      expect(JSON.parse(payload)).toMatchObject({
        notification: {
          title: '+5491100000001',
          body: 'Perfecto, ¿me pasás el link de pago?',
          tag: conversationId,
          data: {
            onActionClick: {
              default: {
                url: `/b/${businessId}/inbox/${conversationId}`,
              },
            },
          },
        },
      });
      expect(options).toEqual({
        ttl: 3600,
        topic: conversationId.replaceAll('-', ''),
      });
      expect(
        await prisma.pushSubscription.count({
          where: { userId: ana, lastSuccessAt: { not: null } },
        }),
      ).toBe(2);
    });

    it('a conversation the bot attends notifies nobody', async () => {
      const job = await inboundPush('wamid.1');

      expect(await push.process(job)).toBe('skipped');
      expect(send).not.toHaveBeenCalled();
    });

    it('an unassigned PENDING conversation notifies every active person, never a disabled account', async () => {
      const job = await inboundPush('wamid.1');
      await setConversation({ status: 'PENDING', paused: true });
      await prisma.user.update({ where: { id: ana }, data: { active: false } });

      await push.process(job);

      expect(endpointsSent()).toEqual(['https://push.example.com/olga-phone']);
    });

    it('a handoff notifies everyone with "quiere hablar con una persona" and the last message', async () => {
      await conversations.recordInbound(
        textEvent('wamid.1', '5491100000001', 'quiero hablar con alguien'),
      );
      const { id } = await prisma.conversation.findFirstOrThrow();
      await prisma.processingJob.updateMany({ data: { status: 'COMPLETED' } });
      await new ContextService(prisma, config).requestHuman(id, 'pidió');
      const job = await queue.claimNext('w1');

      await push.process(job as Parameters<PushService['process']>[0]);

      expect(endpointsSent()).toHaveLength(3);
      expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({
        notification: {
          title: '+5491100000001 quiere hablar con una persona',
          body: 'quiero hablar con alguien',
        },
      });
    });

    it('a 404 or 410 deletes that subscription and the job is done', async () => {
      const job = await inboundPush('wamid.1');
      await setConversation({ assignedToId: ana });
      send.mockImplementation((target): Promise<PushOutcome> =>
        Promise.resolve(
          target.endpoint.endsWith('laptop')
            ? { kind: 'gone' }
            : { kind: 'accepted' },
        ),
      );

      expect(await push.process(job)).toBe('done');

      expect(
        (
          await prisma.pushSubscription.findMany({ where: { userId: ana } })
        ).map((s) => s.endpoint),
      ).toEqual(['https://push.example.com/ana-phone']);
    });

    it('a transient error retries the job; the retry reaches that browser even after a push of another conversation', async () => {
      await inboundPush('wamid.1');
      await setConversation({ assignedToId: ana });
      send.mockImplementation((target): Promise<PushOutcome> =>
        Promise.resolve(
          target.endpoint.endsWith('laptop')
            ? { kind: 'failed', statusCode: 503 }
            : { kind: 'accepted' },
        ),
      );
      const job = await prisma.processingJob.findFirstOrThrow({
        where: { type: 'PUSH_NOTIFICATION' },
      });
      // The job was claimed by inboundPush: process it as the worker would.
      const claimed = {
        id: job.id,
        type: 'PUSH_NOTIFICATION' as const,
        conversationId: job.conversationId,
        messageId: null,
        pushMessageId: job.pushMessageId,
        pushReason: job.pushReason!,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        lockedBy: 'w1',
        createdAt: job.createdAt,
      };

      const error = await push.process(claimed).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'push_send_failed',
        retryable: true,
      });
      expect(await queue.fail(claimed, error, { retryable: true })).toBe(
        'retry_scheduled',
      );
      expect(await prisma.pushSubscription.count()).toBe(3);

      // Meanwhile another conversation's push reaches every browser of Ana.
      await prisma.pushSubscription.updateMany({
        where: { userId: ana },
        data: { lastSuccessAt: new Date() },
      });
      send.mockClear().mockResolvedValue({ kind: 'accepted' });
      await prisma.processingJob.update({
        where: { id: job.id },
        data: { runAfter: new Date(0) },
      });
      const retry = await queue.claimNext('w1');
      expect(retry?.id).toBe(job.id);
      expect(await push.process(retry as typeof claimed)).toBe('done');
      // Every browser again: the notification's tag replaces the earlier one.
      expect(endpointsSent()).toEqual([
        'https://push.example.com/ana-laptop',
        'https://push.example.com/ana-phone',
      ]);
    });

    it("two close messages: the second job's first attempt reaches every browser", async () => {
      await conversations.recordInbound(textEvent('wamid.1'));
      await conversations.recordInbound(textEvent('wamid.2'));
      await setConversation({ assignedToId: ana });
      await prisma.processingJob.updateMany({
        where: { type: 'INBOUND_MESSAGE' },
        data: { status: 'COMPLETED' },
      });
      const first = await queue.claimNext('w1');
      const second = await queue.claimNext('w2');
      type Job = Parameters<PushService['process']>[0];

      // The first job sends after the second one was created.
      await push.process(first as Job);
      send.mockClear();
      await push.process(second as Job);

      expect(endpointsSent()).toEqual([
        'https://push.example.com/ana-laptop',
        'https://push.example.com/ana-phone',
      ]);
    });

    it('a job processed while push is not configured is skipped', async () => {
      const job = await inboundPush('wamid.1');
      await setConversation({ assignedToId: ana });

      expect(
        await new PushService(prisma, offConfig, { send }).process(job),
      ).toBe('skipped');
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('subscriptions', () => {
    it('saving again by endpoint updates its keys and person', async () => {
      await subscriptions.save(olga, {
        endpoint: 'https://push.example.com/ana-phone',
        keys: { p256dh: 'new', auth: 'new' },
        userAgent: 'Firefox',
      });

      expect(
        await prisma.pushSubscription.findUniqueOrThrow({
          where: { endpoint: 'https://push.example.com/ana-phone' },
        }),
      ).toMatchObject({
        userId: olga,
        p256dh: 'new',
        auth: 'new',
        userAgent: 'Firefox',
      });
      expect(await prisma.pushSubscription.count()).toBe(3);
    });

    it("deleting only removes the session user's own", async () => {
      await subscriptions.remove(olga, 'https://push.example.com/ana-phone');
      await subscriptions.remove(ana, 'https://push.example.com/ana-phone');
      await subscriptions.remove(ana, 'https://push.example.com/unknown');

      expect(
        (await prisma.pushSubscription.findMany())
          .map((s) => s.endpoint)
          .sort(),
      ).toEqual([
        'https://push.example.com/ana-laptop',
        'https://push.example.com/olga-phone',
      ]);
    });
  });
});
