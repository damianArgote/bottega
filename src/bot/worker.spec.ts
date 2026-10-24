import { Logger } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Env } from '../config/env.schema.js';
import { QueueSignal } from '../queue/queue-signal.js';
import type { ClaimedJob, QueueService } from '../queue/queue.service.js';
import { type BotService, JobError } from './bot.service.js';
import { BotWorker } from './worker.js';

const job = (id: string): ClaimedJob => ({
  id,
  type: 'INBOUND_MESSAGE',
  conversationId: 'c1',
  messageId: `m-${id}`,
  attempts: 1,
  maxAttempts: 3,
  lockedBy: 'w',
});

function setup(overrides: Partial<Env> = {}) {
  const env: Partial<Env> = {
    WORKER_ENABLED: true,
    QUEUE_POLL_INTERVAL_MS: 10_000,
    QUEUE_IDLE_POLL_INTERVAL_MS: 600_000,
    QUEUE_CONCURRENCY: 2,
    ...overrides,
  };
  const config = {
    get: (key: keyof Env) => env[key],
  } as unknown as AppConfigService;
  const queue = {
    claimNext: vi.fn<QueueService['claimNext']>().mockResolvedValue(null),
    complete: vi.fn<QueueService['complete']>().mockResolvedValue(true),
    fail: vi.fn<QueueService['fail']>().mockResolvedValue('retry_scheduled'),
    nextRunnableAt: vi
      .fn<QueueService['nextRunnableAt']>()
      .mockResolvedValue(null),
  };
  const signal = new QueueSignal();
  const bot = { process: vi.fn<BotService['process']>() };
  const worker = new BotWorker(
    config,
    queue as unknown as QueueService,
    bot as unknown as BotService,
    signal,
  );
  return { worker, queue, bot, signal };
}

describe('BotWorker', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes processed jobs', async () => {
    const { worker, queue, bot } = setup();
    queue.claimNext.mockResolvedValueOnce(job('j1'));
    bot.process.mockResolvedValue({
      outcome: 'done',
      sent: 1,
      uncertain: 0,
      failed: 0,
    });

    expect(await worker.drain()).toBe(1);
    expect(queue.complete).toHaveBeenCalledWith(job('j1'));
  });

  it.each([
    ['an unexpected error', new Error('db down'), true],
    ['a retryable JobError', new JobError('send_rejected_4', true), true],
    ['a final JobError', new JobError('inbound_message_missing', false), false],
  ])('records %s as retryable=%s', async (_label, error, retryable) => {
    const { worker, queue, bot } = setup();
    queue.claimNext.mockResolvedValueOnce(job('j1'));
    bot.process.mockRejectedValue(error);

    await worker.processNext();

    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(job('j1'), error, { retryable });
  });

  it('does not poll when WORKER_ENABLED=false', async () => {
    const { worker, queue } = setup({ WORKER_ENABLED: false });

    worker.onApplicationBootstrap();
    await worker.onModuleDestroy();

    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  it('runs up to QUEUE_CONCURRENCY jobs at once and awaits them on shutdown', async () => {
    const { worker, queue, bot } = setup({ QUEUE_CONCURRENCY: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let active = 0;
    let maxActive = 0;
    let finished = 0;
    let next = 0;
    queue.claimNext.mockImplementation(() =>
      Promise.resolve(next < 3 ? job(`j${(next += 1)}`) : null),
    );
    bot.process.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      finished += 1;
      return { outcome: 'done', sent: 0, uncertain: 0, failed: 0 };
    });

    worker.onApplicationBootstrap();
    await vi.waitFor(() => expect(active).toBe(2));
    const shutdown = worker.onModuleDestroy();
    release();
    await shutdown;

    expect(maxActive).toBe(2);
    // In-flight jobs finished; no new job was claimed after shutdown began.
    expect(finished).toBe(2);
    expect(queue.complete).toHaveBeenCalledTimes(2);
  });

  describe('idle polling', () => {
    const done = { outcome: 'done', sent: 0, uncertain: 0, failed: 0 } as const;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sleeps the idle interval after a round that found no work', async () => {
      const { worker, queue } = setup({ QUEUE_POLL_INTERVAL_MS: 1_000 });

      worker.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      const afterFirstRound = queue.claimNext.mock.calls.length;
      await vi.advanceTimersByTimeAsync(599_000);
      expect(queue.claimNext.mock.calls.length).toBe(afterFirstRound);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(queue.claimNext.mock.calls.length).toBeGreaterThan(
        afterFirstRound,
      );
      await worker.onModuleDestroy();
    });

    it('claims a job as soon as one is enqueued, without waiting the idle interval', async () => {
      const { worker, queue, bot, signal } = setup();
      bot.process.mockResolvedValue(done);

      worker.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      queue.claimNext.mockResolvedValueOnce(job('j1'));
      signal.notifyEnqueued();
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.process).toHaveBeenCalledWith(job('j1'));
      expect(queue.complete).toHaveBeenCalledWith(job('j1'));
      await worker.onModuleDestroy();
    });

    it('wakes up when a pending retry becomes due', async () => {
      const { worker, queue } = setup({ QUEUE_POLL_INTERVAL_MS: 1_000 });
      queue.nextRunnableAt.mockResolvedValue(new Date('2026-10-24T12:00:30Z'));

      worker.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      const afterFirstRound = queue.claimNext.mock.calls.length;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(queue.claimNext.mock.calls.length).toBe(afterFirstRound);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(queue.claimNext.mock.calls.length).toBeGreaterThan(
        afterFirstRound,
      );
      await worker.onModuleDestroy();
    });

    it('keeps the regular pace after a round that processed work', async () => {
      const { worker, queue, bot } = setup({ QUEUE_POLL_INTERVAL_MS: 1_000 });
      bot.process.mockResolvedValue(done);
      queue.claimNext.mockResolvedValueOnce(job('j1'));

      worker.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      const afterFirstRound = queue.claimNext.mock.calls.length;
      // A round that processed work does not look for the next due job.
      expect(queue.nextRunnableAt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(queue.claimNext.mock.calls.length).toBeGreaterThan(
        afterFirstRound,
      );
      await worker.onModuleDestroy();
    });

    it('ignores enqueue signals after shutdown', async () => {
      const { worker, queue, signal } = setup();

      worker.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      await worker.onModuleDestroy();
      const calls = queue.claimNext.mock.calls.length;
      signal.notifyEnqueued();
      await vi.advanceTimersByTimeAsync(600_000);

      expect(queue.claimNext.mock.calls.length).toBe(calls);
    });

    it('does not query the queue again when shutdown starts mid-round', async () => {
      const { worker, queue } = setup({ QUEUE_CONCURRENCY: 1 });
      let releaseClaim!: (value: null) => void;
      queue.claimNext.mockReturnValueOnce(
        new Promise((resolve) => (releaseClaim = resolve)),
      );

      worker.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      const shutdown = worker.onModuleDestroy();
      releaseClaim(null);
      await shutdown;
      await vi.advanceTimersByTimeAsync(600_000);

      expect(queue.nextRunnableAt).not.toHaveBeenCalled();
      expect(queue.claimNext).toHaveBeenCalledTimes(1);
    });
  });
});
