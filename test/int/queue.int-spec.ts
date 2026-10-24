import { QueueSignal } from '../../src/queue/queue-signal.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueService } from '../../src/queue/queue.service.js';
import { connectPrisma, resetDb, testConfig, textEvent } from './helpers.js';

const USER_A = '5491100000001';
const USER_B = '5491100000002';

describe('QueueService (integration)', () => {
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let queue: QueueService;

  beforeAll(async () => {
    prisma = await connectPrisma();
    const config = testConfig();
    conversations = new ConversationsService(prisma, config, new QueueSignal());
    queue = new QueueService(prisma, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  const enqueue = (waMessageId: string, from = USER_A) =>
    conversations.recordInbound(textEvent(waMessageId, from));

  const jobFor = (waMessageId: string) =>
    prisma.processingJob.findFirstOrThrow({
      where: { message: { waMessageId } },
    });

  /** Moves a job's timers into the past instead of sleeping. */
  const expire = (jobId: string) => prisma.$executeRaw`
    UPDATE processing_job
    SET lease_expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second',
        run_after = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE id = ${jobId}::uuid`;

  it('returns null when the queue is empty', async () => {
    expect(await queue.claimNext('w1')).toBeNull();
  });

  it('claims a pending job with a lease and an incremented attempt', async () => {
    await enqueue('wamid.1');

    const job = await queue.claimNext('w1');

    expect(job).toMatchObject({
      type: 'INBOUND_MESSAGE',
      attempts: 1,
      maxAttempts: 3,
      lockedBy: 'w1',
    });
    const row = await prisma.processingJob.findUniqueOrThrow({
      where: { id: job!.id },
    });
    expect(row.status).toBe('PROCESSING');
    const leaseMs = row.leaseExpiresAt!.getTime() - Date.now();
    expect(leaseMs).toBeGreaterThan(100_000);
    expect(leaseMs).toBeLessThanOrEqual(121_000);
  });

  it('processes one conversation strictly in order', async () => {
    await enqueue('wamid.1');
    await enqueue('wamid.2');

    const first = await queue.claimNext('w1');
    expect(first?.id).toBe((await jobFor('wamid.1')).id);
    // The second job is blocked while the first is in progress.
    expect(await queue.claimNext('w2')).toBeNull();

    expect(await queue.complete(first!)).toBe(true);
    const second = await queue.claimNext('w2');
    expect(second?.id).toBe((await jobFor('wamid.2')).id);
  });

  it('keeps later jobs blocked while the head job waits for its retry', async () => {
    await enqueue('wamid.1');
    await enqueue('wamid.2');
    const first = await queue.claimNext('w1');
    await queue.fail(first!, new Error('boom'), { retryable: true });

    // wamid.1 is PENDING in backoff; wamid.2 must not overtake it.
    expect(await queue.claimNext('w1')).toBeNull();

    await expire(first!.id);
    expect((await queue.claimNext('w1'))?.id).toBe(first!.id);
  });

  it('never hands two jobs of one conversation to concurrent claims', async () => {
    for (let i = 0; i < 5; i += 1) {
      await enqueue(`wamid.${i}`);
    }

    const claimed = await Promise.all(
      Array.from({ length: 6 }, (_, i) => queue.claimNext(`w${i}`)),
    );

    const jobs = claimed.filter((job) => job !== null);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe((await jobFor('wamid.0')).id);
  });

  it('claims jobs of different conversations in parallel', async () => {
    await enqueue('wamid.a1', USER_A);
    await enqueue('wamid.a2', USER_A);
    await enqueue('wamid.b1', USER_B);

    const claimed = await Promise.all([
      queue.claimNext('w1'),
      queue.claimNext('w2'),
      queue.claimNext('w3'),
    ]);

    const ids = claimed.filter((job) => job !== null).map((job) => job.id);
    expect(ids.sort()).toEqual(
      [(await jobFor('wamid.a1')).id, (await jobFor('wamid.b1')).id].sort(),
    );
  });

  it('reclaims a PROCESSING job whose lease expired', async () => {
    await enqueue('wamid.1');
    const crashed = await queue.claimNext('w-crashed');
    expect(await queue.claimNext('w2')).toBeNull();

    await expire(crashed!.id);
    const recovered = await queue.claimNext('w2');

    expect(recovered).toMatchObject({
      id: crashed!.id,
      attempts: 2,
      lockedBy: 'w2',
    });
    // The crashed worker lost ownership: its late completion is rejected.
    expect(await queue.complete(crashed!)).toBe(false);
    expect(await queue.complete(recovered!)).toBe(true);
  });

  it('treats a single-active index conflict as nothing claimed', async () => {
    await enqueue('wamid.1');
    await enqueue('wamid.2');
    // Corrupt order on purpose: the newer job is PROCESSING while the older
    // one is still pending and therefore the head of the conversation.
    const newer = await jobFor('wamid.2');
    await prisma.processingJob.update({
      where: { id: newer.id },
      data: {
        status: 'PROCESSING',
        lockedBy: 'other',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(await queue.claimNext('w1')).toBeNull();
  });

  it('retries with exponential backoff and fails after max attempts', async () => {
    await enqueue('wamid.1');
    const error = Object.assign(new Error('secret body text'), {
      code: 'ETIMEDOUT',
    });

    const backoffs: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await queue.claimNext('w1');
      expect(job?.attempts).toBe(attempt);
      const outcome = await queue.fail(job!, error, { retryable: true });
      const row = await prisma.processingJob.findUniqueOrThrow({
        where: { id: job!.id },
      });
      expect(row.lastError).toBe('Error:ETIMEDOUT');
      expect(row.lockedBy).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      if (attempt < 3) {
        expect(outcome).toBe('retry_scheduled');
        expect(row.status).toBe('PENDING');
        backoffs.push(row.runAfter.getTime() - Date.now());
        // Not runnable before its backoff elapses.
        expect(await queue.claimNext('w1')).toBeNull();
        await expire(job!.id);
      } else {
        expect(outcome).toBe('failed');
        expect(row.status).toBe('FAILED');
      }
    }
    // 5s·2^1 = 10s, 5s·2^2 = 20s (with some clock tolerance).
    expect(backoffs[0]).toBeGreaterThan(8_000);
    expect(backoffs[0]).toBeLessThanOrEqual(10_500);
    expect(backoffs[1]).toBeGreaterThan(18_000);
    expect(backoffs[1]).toBeLessThanOrEqual(20_500);
  });

  it('fails immediately on non-retryable errors', async () => {
    await enqueue('wamid.1');
    const job = await queue.claimNext('w1');

    expect(
      await queue.fail(job!, new TypeError('x'), { retryable: false }),
    ).toBe('failed');
  });

  it('does not let a FAILED job block later jobs of its conversation', async () => {
    await enqueue('wamid.1');
    await enqueue('wamid.2');
    const first = await queue.claimNext('w1');
    await queue.fail(first!, new Error('boom'), { retryable: false });

    const next = await queue.claimNext('w1');

    expect(next?.id).toBe((await jobFor('wamid.2')).id);
  });

  it('extends the lease only for the owner', async () => {
    await enqueue('wamid.1');
    const job = await queue.claimNext('w1');

    expect(await queue.extendLease(job!)).toBe(true);
    expect(await queue.extendLease({ ...job!, lockedBy: 'someone-else' })).toBe(
      false,
    );
  });
});
