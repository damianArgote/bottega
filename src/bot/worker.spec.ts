import { Logger } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Env } from '../config/env.schema.js';
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
  };
  const bot = { process: vi.fn<BotService['process']>() };
  const worker = new BotWorker(
    config,
    queue as unknown as QueueService,
    bot as unknown as BotService,
  );
  return { worker, queue, bot };
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
});
