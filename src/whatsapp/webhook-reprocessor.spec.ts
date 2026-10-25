import { Logger } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Env } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { WebhookEventProcessor } from './webhook-event-processor.js';
import { WebhookEventsService } from './webhook-events.service.js';
import { WebhookReprocessor } from './webhook-reprocessor.js';

function setup(workerEnabled = true) {
  const config = {
    get: (key: keyof Env) => (key === 'WORKER_ENABLED' ? workerEnabled : 0),
  } as unknown as AppConfigService;
  const pending: Array<{ id: bigint }> = [];
  const queryRaw = vi.fn((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('').includes('count(*)')
        ? [{ count: BigInt(pending.length) }]
        : [...pending],
    ),
  );
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const processor = {
    process: vi.fn<WebhookEventProcessor['process']>(),
    store: vi.fn<WebhookEventProcessor['store']>(),
  };
  const reprocessor = new WebhookReprocessor(
    prisma,
    processor as unknown as WebhookEventProcessor,
    config,
  );
  return { reprocessor, processor, queryRaw, pending };
}

describe('WebhookReprocessor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs once shortly after boot and then stays idle when nothing is pending', async () => {
    const { reprocessor, queryRaw } = setup();

    reprocessor.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    const calls = queryRaw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(calls).toBeGreaterThan(0);
    expect(queryRaw.mock.calls.length).toBe(calls);
    await reprocessor.onModuleDestroy();
  });

  it('keeps retrying while events stay pending', async () => {
    const { reprocessor, processor, pending, queryRaw } = setup();
    pending.push({ id: 1n });
    processor.process.mockResolvedValue(false);

    reprocessor.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    const afterBoot = processor.process.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(afterBoot).toBe(1);
    expect(processor.process.mock.calls.length).toBe(2);
    expect(queryRaw).toHaveBeenCalled();
    await reprocessor.onModuleDestroy();
  });

  it('keeps the earliest scheduled run', async () => {
    const { reprocessor, queryRaw } = setup();
    reprocessor.onApplicationBootstrap();

    reprocessor.schedule(30_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(queryRaw).toHaveBeenCalled();
    await reprocessor.onModuleDestroy();
  });

  it('never runs when the worker is disabled', async () => {
    const { reprocessor, queryRaw } = setup(false);

    reprocessor.onApplicationBootstrap();
    reprocessor.schedule(0);
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('does not run after shutdown', async () => {
    const { reprocessor, queryRaw } = setup();
    reprocessor.onApplicationBootstrap();

    await reprocessor.onModuleDestroy();
    reprocessor.schedule(0);
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('WebhookEventsService', () => {
  it('asks the reprocessor for a retry only when processing fails', async () => {
    const processor = {
      store: vi.fn<WebhookEventProcessor['store']>().mockResolvedValue(7n),
      process: vi.fn<WebhookEventProcessor['process']>(),
    };
    const reprocessor = { schedule: vi.fn() };
    const service = new WebhookEventsService(
      processor as unknown as WebhookEventProcessor,
      reprocessor as unknown as WebhookReprocessor,
    );

    processor.process.mockResolvedValueOnce(true);
    await service.receive({ a: 1 }, 'line-1');
    expect(reprocessor.schedule).not.toHaveBeenCalled();

    processor.process.mockResolvedValueOnce(false);
    await service.receive({ a: 2 }, null);
    expect(reprocessor.schedule).toHaveBeenCalledTimes(1);
    expect(processor.store).toHaveBeenLastCalledWith({ a: 2 }, null);
    expect(processor.process).toHaveBeenLastCalledWith(7n);
  });

  it('propagates a storage failure (so the webhook answers 5xx)', async () => {
    const processor = {
      store: vi
        .fn<WebhookEventProcessor['store']>()
        .mockRejectedValue(new Error('db down')),
      process: vi.fn<WebhookEventProcessor['process']>(),
    };
    const service = new WebhookEventsService(
      processor as unknown as WebhookEventProcessor,
      { schedule: vi.fn() } as unknown as WebhookReprocessor,
    );

    await expect(service.receive({}, null)).rejects.toThrow('db down');
    expect(processor.process).not.toHaveBeenCalled();
  });
});
