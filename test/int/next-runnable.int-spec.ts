import { QueueSignal } from '../../src/queue/queue-signal.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueService } from '../../src/queue/queue.service.js';
import { connectPrisma, resetDb, testConfig, textEvent } from './helpers.js';

describe('QueueService.nextRunnableAt (integration)', () => {
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

  it('is null when no job is pending or running', async () => {
    expect(await queue.nextRunnableAt()).toBeNull();
  });

  it('returns the run_after of a pending job', async () => {
    await conversations.recordInbound(textEvent('wamid.1', '5491100000001'));
    await prisma.$executeRaw`
      UPDATE processing_job
      SET run_after = (now() AT TIME ZONE 'UTC') + interval '45 seconds'`;

    const at = await queue.nextRunnableAt();
    const job = await prisma.processingJob.findFirstOrThrow();

    expect(at?.getTime()).toBe(job.runAfter.getTime());
    expect(at!.getTime() - Date.now()).toBeGreaterThan(40_000);
    expect(at!.getTime() - Date.now()).toBeLessThan(50_000);
  });

  it('uses the lease of a running job and ignores completed ones', async () => {
    await conversations.recordInbound(textEvent('wamid.1', '5491100000001'));
    await conversations.recordInbound(textEvent('wamid.2', '5491100000002'));
    const first = await queue.claimNext('worker-a');
    await queue.claimNext('worker-b');
    await queue.complete(first!);

    const at = await queue.nextRunnableAt();
    const running = await prisma.processingJob.findFirstOrThrow({
      where: { status: 'PROCESSING' },
    });

    expect(at?.getTime()).toBe(running.leaseExpiresAt!.getTime());
  });

  it('is not shifted by a non-UTC session time zone', async () => {
    await conversations.recordInbound(textEvent('wamid.1', '5491100000001'));

    const at = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'`,
      );
      return new QueueService(
        tx as unknown as PrismaService,
        testConfig(),
      ).nextRunnableAt();
    });

    expect(Math.abs(at!.getTime() - Date.now())).toBeLessThan(2_000);
  });
});
