import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { millis, UTC_NOW } from '../prisma/sql.js';
import {
  TEMPLATE_SYNC_INTERVAL_MS,
  TemplatesService,
} from './templates.service.js';

const STARTUP_DELAY_MS = 15_000;
/** Check again at least this often while some business has an account. */
const MAX_WAIT_MS = 60 * 60 * 1000;
/** Syncs per run, so one run never holds the worker for long. */
const BATCH_SIZE = 20;

/** Businesses with an active line that has an account id and a token. */
const HAS_ACCOUNT = Prisma.sql`EXISTS (
  SELECT 1 FROM line
  WHERE line.business_id = business.id AND line.active
    AND line.waba_id IS NOT NULL AND line.access_token_encrypted IS NOT NULL)`;

/**
 * Re-reads each business's message templates from Meta once a day, in the
 * queue worker's process (WORKER_ENABLED). A due business is claimed by
 * moving its `templates_sync_next_at` a day ahead under
 * `FOR UPDATE SKIP LOCKED`, so two instances never sync the same one. A
 * business never synced (null) is due now. Without any account no timer
 * is set, so a serverless database can suspend; a manual sync (or the next
 * start) sets it again.
 */
@Injectable()
export class TemplatesSyncScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TemplatesSyncScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private dueAt = 0;
  private running = false;
  private current: Promise<unknown> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
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
  schedule(delayMs = 0): void {
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

  /** Syncs the due businesses (up to a batch); returns how many it synced. */
  async runDue(): Promise<number> {
    let synced = 0;
    while (synced < BATCH_SIZE) {
      const [due] = await this.prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE business
        SET templates_sync_next_at = ${UTC_NOW} + ${millis(TEMPLATE_SYNC_INTERVAL_MS)}
        WHERE id = (
          SELECT id FROM business
          WHERE (templates_sync_next_at IS NULL
                 OR templates_sync_next_at <= ${UTC_NOW})
            AND ${HAS_ACCOUNT}
          ORDER BY templates_sync_next_at NULLS FIRST
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`;
      if (!due) {
        break;
      }
      synced += 1;
      try {
        await this.templates.sync(due.id);
      } catch {
        // The sync stored its error code on the business; next one tomorrow.
      }
    }
    return synced;
  }

  /** Milliseconds until the next due business; null when there is none. */
  async nextDelay(): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<
      Array<{ next: Date | null; never: boolean }>
    >`
      SELECT min(templates_sync_next_at) AS next,
             bool_or(templates_sync_next_at IS NULL) AS never
      FROM business WHERE ${HAS_ACCOUNT}`;
    if (row?.never) {
      return 0;
    }
    if (!row?.next) {
      return null;
    }
    // Prisma reads the UTC timestamp as a Date already.
    return Math.max(0, row.next.getTime() - Date.now());
  }

  private async tick(): Promise<void> {
    try {
      const synced = await this.runDue();
      const delay = synced >= BATCH_SIZE ? 0 : await this.nextDelay();
      if (delay !== null) {
        this.schedule(Math.min(delay, MAX_WAIT_MS));
      }
    } catch (error) {
      this.logger.warn(
        `Template sync run failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      this.schedule(MAX_WAIT_MS);
    }
  }
}
