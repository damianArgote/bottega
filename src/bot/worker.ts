import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { AppConfigService } from '../config/app-config.service.js';
import { pollDelayMs } from '../queue/poll-delay.js';
import { QueueSignal } from '../queue/queue-signal.js';
import { QueueService, sanitizeError } from '../queue/queue.service.js';
import { BotService, JobError } from './bot.service.js';

/**
 * Polls the job queue and processes jobs with up to QUEUE_CONCURRENCY slots.
 *
 * Each round tops up idle slots, waits for them to drain, and then schedules
 * the next round: soon while there is work, after QUEUE_IDLE_POLL_INTERVAL_MS
 * when there is none (so a serverless database can suspend), or when the
 * next retry or expiring lease is due. A job enqueued by this process wakes
 * the worker right away through {@link QueueSignal}.
 *
 * A plain timer is used instead of @nestjs/schedule: the delay changes per
 * round, and shutdown needs to await in-flight work, which a cron registry
 * does not give us.
 */
@Injectable()
export class BotWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotWorker.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly slots = new Set<Promise<number>>();
  private timer: NodeJS.Timeout | undefined;
  private subscription: Subscription | undefined;
  private running = false;
  private roundInProgress = false;
  /** A job was enqueued while the current round was running. */
  private wokeDuringRound = false;
  private round: Promise<void> | undefined;

  constructor(
    private readonly config: AppConfigService,
    private readonly queue: QueueService,
    private readonly bot: BotService,
    private readonly signal: QueueSignal,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED')) {
      this.logger.log('Queue worker disabled (WORKER_ENABLED=false)');
      return;
    }
    this.running = true;
    this.subscription = this.signal.enqueued$.subscribe(() => this.wake());
    this.startRound();
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
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.round, ...this.slots]);
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

  /** A job was enqueued: use idle slots now and cut an idle sleep short. */
  private wake(): void {
    if (!this.running) {
      return;
    }
    if (this.roundInProgress) {
      this.wokeDuringRound = true;
      // The running round reschedules after its own slots; these new
      // slots are tracked in `slots` and awaited on shutdown.
      void this.fillSlots();
      return;
    }
    this.startRound();
  }

  private startRound(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running || this.roundInProgress) {
      return;
    }
    this.round = this.runRound();
  }

  /** One round: drain with idle slots, then schedule the next round. */
  private async runRound(): Promise<void> {
    this.roundInProgress = true;
    this.wokeDuringRound = false;
    let delay: number;
    try {
      const processed = await Promise.all(this.fillSlots());
      if (!this.running) {
        return;
      }
      delay = await this.nextDelay(processed.some((count) => count > 0));
      if (this.wokeDuringRound) {
        // Work arrived after this round measured the queue (it may have run
        // and failed already, leaving a retry this round never saw): keep
        // the regular pace so the next round measures again.
        delay = Math.min(delay, this.config.get('QUEUE_POLL_INTERVAL_MS'));
      }
    } finally {
      this.roundInProgress = false;
    }
    if (this.running) {
      this.timer = setTimeout(() => this.startRound(), delay);
    }
  }

  private async nextDelay(foundWork: boolean): Promise<number> {
    const pollIntervalMs = this.config.get('QUEUE_POLL_INTERVAL_MS');
    // Slots started by a wake() during the round may still be running.
    const busy = foundWork || this.slots.size > 0;
    let nextRunnableAt: Date | null = null;
    if (!busy) {
      try {
        nextRunnableAt = await this.queue.nextRunnableAt();
      } catch (error) {
        // Database unavailable: retry at the regular pace.
        this.logger.error(`Queue poll failed: ${sanitizeError(error)}`);
        return pollIntervalMs;
      }
    }
    return pollDelayMs({
      busy,
      nextRunnableAt,
      now: new Date(),
      pollIntervalMs,
      idlePollIntervalMs: this.config.get('QUEUE_IDLE_POLL_INTERVAL_MS'),
    });
  }

  /** Starts slots up to QUEUE_CONCURRENCY; each resolves to the jobs it processed. */
  private fillSlots(): Promise<number>[] {
    const concurrency = this.config.get('QUEUE_CONCURRENCY');
    const started: Promise<number>[] = [];
    while (this.running && this.slots.size < concurrency) {
      const slot: Promise<number> = this.runSlot().finally(() => {
        this.slots.delete(slot);
      });
      this.slots.add(slot);
      started.push(slot);
    }
    return started;
  }

  private async runSlot(): Promise<number> {
    let processed = 0;
    try {
      while (this.running && (await this.processNext())) {
        processed += 1;
      }
    } catch (error) {
      // Queue/database unavailable: the next round retries.
      this.logger.error(`Queue poll failed: ${sanitizeError(error)}`);
    }
    return processed;
  }
}
