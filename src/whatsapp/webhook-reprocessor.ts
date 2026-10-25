import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { millis, UTC_NOW } from '../prisma/sql.js';
import { sanitizeError } from '../queue/queue.service.js';
import { WebhookEventProcessor } from './webhook-event-processor.js';

/** A failed event is retried this many times in total, then left for review. */
export const WEBHOOK_MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 30_000;
const STARTUP_DELAY_MS = 5_000;
const BATCH_SIZE = 50;
/** Never-attempted events younger than this may still be in flight. */
const IN_FLIGHT_GRACE_MS = 60_000;

export interface ReprocessResult {
  processed: number;
  failed: number;
  /** Pending events still eligible for another attempt. */
  remaining: number;
}

/**
 * Retries stored webhook events whose processing failed. It does not poll:
 * it runs once shortly after boot (catching events left by a crash) and then
 * only when a failure asks for it, so a serverless database can suspend.
 */
@Injectable()
export class WebhookReprocessor
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookReprocessor.name);
  private timer: NodeJS.Timeout | undefined;
  private dueAt = 0;
  private running = false;
  private current: Promise<unknown> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: WebhookEventProcessor,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED')) {
      return;
    }
    this.running = true;
    this.schedule(STARTUP_DELAY_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  /** Asks for a run in `delayMs` (keeps an earlier one already scheduled). */
  schedule(delayMs = RETRY_DELAY_MS): void {
    if (!this.running) {
      return;
    }
    const at = Date.now() + delayMs;
    if (this.timer && this.dueAt <= at) {
      return;
    }
    clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.current = this.tick();
    }, delayMs);
  }

  /** Processes one batch of pending events, oldest first. */
  async runOnce(): Promise<ReprocessResult> {
    const rows = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM webhook_event
      WHERE processed_at IS NULL
        AND attempts < ${WEBHOOK_MAX_ATTEMPTS}
        AND (attempts > 0 OR received_at < ${UTC_NOW} - ${millis(IN_FLIGHT_GRACE_MS)})
      ORDER BY received_at
      LIMIT ${BATCH_SIZE}`;
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      if (await this.processor.process(row.id)) {
        processed += 1;
      } else {
        failed += 1;
      }
    }
    const [pending] = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM webhook_event
      WHERE processed_at IS NULL AND attempts < ${WEBHOOK_MAX_ATTEMPTS}`;
    return { processed, failed, remaining: Number(pending?.count ?? 0) };
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      if (result.processed > 0 || result.failed > 0) {
        this.logger.log(
          `Reprocessed webhook events: ${result.processed} processed, ${result.failed} failed, ${result.remaining} pending`,
        );
      }
      if (result.remaining > 0) {
        this.schedule(RETRY_DELAY_MS);
      }
    } catch (error) {
      this.logger.error(`Webhook reprocessing failed: ${sanitizeError(error)}`);
      this.schedule(RETRY_DELAY_MS);
    }
  }
}
