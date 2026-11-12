import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { type Payment } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UTC_NOW } from '../prisma/sql.js';
import { PaymentsService } from './payments.service.js';

const STARTUP_DELAY_MS = 10_000;
/** Check again at least this often while some payment is pending. */
const MAX_WAIT_MS = 60 * 60_000;
/** Payments expired per transaction. */
const BATCH_SIZE = 50;

/**
 * Marks pending payments past `expiresAt` as EXPIRED and emits
 * `payment.expired`, in the queue worker's process (WORKER_ENABLED). Rows
 * are taken with `FOR UPDATE SKIP LOCKED`, so two instances (or a
 * notification confirming the same payment) never both change one. Without
 * pending payments no timer is set, so a serverless database can suspend;
 * a new charge schedules the run at its own expiry.
 */
@Injectable()
export class PaymentExpiryScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentExpiryScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private dueAt = 0;
  private running = false;
  private current: Promise<unknown> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED')) {
      return;
    }
    this.running = true;
    this.payments.onCreated((expiresAt) =>
      this.schedule(Math.max(0, expiresAt.getTime() - Date.now())),
    );
    this.schedule(STARTUP_DELAY_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  /** Asks for a run in `delayMs` (keeps an earlier one already scheduled). */
  schedule(delayMs = 0): void {
    if (!this.running) {
      return;
    }
    const wait = Math.min(delayMs, MAX_WAIT_MS);
    const at = Date.now() + wait;
    if (this.timer && this.dueAt <= at) {
      return;
    }
    clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.current = this.tick();
    }, wait);
  }

  /** Expires the due payments (one batch); returns how many it expired. */
  async runDue(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE payment SET status = 'EXPIRED', updated_at = ${UTC_NOW}
        WHERE id IN (
          SELECT id FROM payment
          WHERE status = 'PENDING' AND expires_at <= ${UTC_NOW}
          ORDER BY expires_at
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`;
      if (expired.length === 0) {
        return 0;
      }
      const rows: Payment[] = await tx.payment.findMany({
        where: { id: { in: expired.map((row) => row.id) } },
      });
      for (const payment of rows) {
        await this.payments.emit(tx, 'payment.expired', payment);
      }
      return rows.length;
    });
  }

  /** Milliseconds until the next pending payment expires; null when none. */
  async nextDelay(): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ next: Date | null }>>`
      SELECT min(expires_at) AS next FROM payment WHERE status = 'PENDING'`;
    if (!row?.next) {
      return null;
    }
    return Math.max(0, row.next.getTime() - Date.now());
  }

  private async tick(): Promise<void> {
    try {
      const expired = await this.runDue();
      const delay = expired >= BATCH_SIZE ? 0 : await this.nextDelay();
      if (delay !== null) {
        this.schedule(delay);
      }
    } catch (error) {
      this.logger.warn(
        `Payment expiry run failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      this.schedule(MAX_WAIT_MS);
    }
  }
}
