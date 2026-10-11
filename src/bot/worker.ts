import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { QueueService, sanitizeError } from '../queue/queue.service.js';
import { BotService, JobError } from './bot.service.js';

/**
 * Polls the job queue and processes jobs with up to QUEUE_CONCURRENCY slots.
 *
 * A plain timer is used instead of @nestjs/schedule: the interval comes from
 * config, a tick only tops up idle slots (no overlapping ticks to guard
 * against), and shutdown needs to await in-flight work, which a cron
 * registry does not give us.
 */
@Injectable()
export class BotWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotWorker.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly slots = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly queue: QueueService,
    private readonly bot: BotService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED')) {
      this.logger.log('Queue worker disabled (WORKER_ENABLED=false)');
      return;
    }
    this.running = true;
    this.timer = setInterval(
      () => this.fillSlots(),
      this.config.get('QUEUE_POLL_INTERVAL_MS'),
    );
    this.fillSlots();
    this.logger.log(
      `Queue worker started with ${this.config.get('QUEUE_CONCURRENCY')} slots`,
    );
  }

  /**
   * Stops claiming new jobs and waits for the ones in progress. Runs in
   * onModuleDestroy (not onApplicationShutdown) because Nest destroys global
   * modules last: in-flight jobs still have a connected PrismaService here.
   */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.slots]);
  }

  /**
   * Claims and processes one job. Returns false when nothing was claimable.
   * Never throws for job failures (they are recorded on the job).
   */
  async processNext(): Promise<boolean> {
    const job = await this.queue.claimNext(this.workerId);
    if (!job) {
      return false;
    }
    try {
      await this.bot.process(job);
      await this.queue.complete(job);
    } catch (error) {
      const retryable = !(error instanceof JobError) || error.retryable;
      const outcome = await this.queue.fail(job, error, { retryable });
      this.logger.warn(
        `Job ${job.id} attempt ${job.attempts}/${job.maxAttempts} failed (${sanitizeError(error)}): ${outcome}`,
      );
    }
    return true;
  }

  /** Processes jobs until none is claimable. Used by tests. */
  async drain(): Promise<number> {
    let processed = 0;
    while (await this.processNext()) {
      processed += 1;
    }
    return processed;
  }

  private fillSlots(): void {
    const concurrency = this.config.get('QUEUE_CONCURRENCY');
    while (this.running && this.slots.size < concurrency) {
      const slot: Promise<void> = this.runSlot().finally(() => {
        this.slots.delete(slot);
      });
      this.slots.add(slot);
    }
  }

  private async runSlot(): Promise<void> {
    try {
      while (this.running && (await this.processNext())) {
        // keep draining while there is work
      }
    } catch (error) {
      // Queue/database unavailable: the next tick retries.
      this.logger.error(`Queue poll failed: ${sanitizeError(error)}`);
    }
  }
}
