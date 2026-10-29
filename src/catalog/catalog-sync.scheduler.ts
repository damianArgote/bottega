import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { millis, UTC_NOW } from '../prisma/sql.js';
import {
  CatalogSheetService,
  SYNC_INTERVAL_MS,
} from './catalog-sheet.service.js';

const STARTUP_DELAY_MS = 10_000;
/** Check again at least this often while some business has a sheet. */
const MAX_WAIT_MS = SYNC_INTERVAL_MS;
/** Syncs per run, so one run never holds the worker for long. */
const BATCH_SIZE = 20;

/**
 * Re-reads the businesses' Google Sheets every hour, in the queue worker's
 * process (WORKER_ENABLED). A due business is claimed by moving its
 * `catalog_sync_next_at` one hour ahead under `FOR UPDATE SKIP LOCKED`, so
 * two instances never sync the same sheet. Without any sheet no timer is
 * set, so a serverless database can suspend.
 */
@Injectable()
export class CatalogSyncScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CatalogSyncScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private dueAt = 0;
  private running = false;
  private current: Promise<unknown> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: CatalogSheetService,
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

  /** Syncs the due sheets (up to a batch); returns how many it synced. */
  async runDue(): Promise<number> {
    let synced = 0;
    while (synced < BATCH_SIZE) {
      const [due] = await this.prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE business SET catalog_sync_next_at = ${UTC_NOW} + ${millis(SYNC_INTERVAL_MS)}
        WHERE id = (
          SELECT id FROM business
          WHERE catalog_sheet_url IS NOT NULL
            AND catalog_sync_next_at <= ${UTC_NOW}
          ORDER BY catalog_sync_next_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`;
      if (!due) {
        break;
      }
      synced += 1;
      try {
        await this.sheets.sync(due.id, null);
      } catch {
        // The sync stored its error code on the business; next one in an hour.
      }
    }
    return synced;
  }

  /** Milliseconds until the next due sheet; null when there is none. */
  async nextDelay(): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ next: Date | null }>>`
      SELECT min(catalog_sync_next_at) AS next FROM business
      WHERE catalog_sheet_url IS NOT NULL`;
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
        `Catalog sync run failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      this.schedule(MAX_WAIT_MS);
    }
  }
}
