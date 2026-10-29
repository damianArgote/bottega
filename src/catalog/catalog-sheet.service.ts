import { isDeepStrictEqual } from 'node:util';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CatalogImportSource,
  CatalogImportStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canApplyAlone, isPublishedSheetCsvUrl } from './catalog-sheet.js';
import {
  CatalogService,
  type ImportView,
  PREVIEW_TTL_MS,
} from './catalog.service.js';
import {
  SHEET_FETCHER,
  SheetFetchError,
  type SheetFetcher,
} from './sheet-fetcher.js';

/** How often a business's sheet is read again. */
export const SYNC_INTERVAL_MS = 60 * 60_000;

export interface SheetView {
  url: string | null;
  syncedAt: Date | null;
  /** Code of the last sync's failure (e.g. sheet_http_404), or null. */
  syncError: string | null;
  nextSyncAt: Date | null;
}

export type SyncResult =
  /** The sheet has no changes: no import is created. */
  | { outcome: 'unchanged' }
  | { outcome: 'applied'; import: ImportView }
  /** Waits for a person: row errors, an unconfirmed mapping, >30% gone. */
  | { outcome: 'preview'; import: ImportView };

/**
 * A business's Google Sheet published as CSV: stored, read every hour by
 * the scheduler or on demand, and imported through the same process as a
 * file. A sync applies by itself only when it is safe (see canApplyAlone).
 */
@Injectable()
export class CatalogSheetService {
  private readonly logger = new Logger(CatalogSheetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(SHEET_FETCHER) private readonly fetchSheet: SheetFetcher,
  ) {}

  async get(businessId: string): Promise<SheetView> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        catalogSheetUrl: true,
        catalogSyncedAt: true,
        catalogSyncError: true,
        catalogSyncNextAt: true,
      },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    return {
      url: business.catalogSheetUrl,
      syncedAt: business.catalogSyncedAt,
      syncError: business.catalogSyncError,
      nextSyncAt: business.catalogSheetUrl ? business.catalogSyncNextAt : null,
    };
  }

  /**
   * Sets (due now) or removes the sheet. 400 for anything but a sheet
   * published as CSV.
   */
  async set(businessId: string, url: string | null): Promise<SheetView> {
    if (url !== null && !isPublishedSheetCsvUrl(url)) {
      throw new BadRequestException(
        'El link tiene que ser una hoja de Google publicada como CSV (Archivo → Compartir → Publicar en la web → CSV).',
      );
    }
    await this.get(businessId);
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        catalogSheetUrl: url,
        catalogSyncNextAt: url ? new Date() : null,
        catalogSyncError: null,
      },
    });
    return this.get(businessId);
  }

  /**
   * Reads the sheet and imports it. A newer sync discards the business's
   * older pending sheet preview. `userId` is who asked (null: scheduled).
   * 409 without a sheet; 502 when it cannot be downloaded.
   */
  async sync(businessId: string, userId: string | null): Promise<SyncResult> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { catalogSheetUrl: true },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    if (!business.catalogSheetUrl) {
      throw new ConflictException({
        message: 'El negocio no tiene una hoja de Google cargada.',
        code: 'NO_SHEET',
      });
    }
    let text: string;
    try {
      text = await this.fetchSheet(business.catalogSheetUrl);
    } catch (error) {
      const code =
        error instanceof SheetFetchError ? error.code : 'sheet_unexpected';
      await this.markSynced(businessId, code);
      this.logger.warn(`Sheet sync failed business=${businessId} code=${code}`);
      throw new BadGatewayException({
        message:
          'No pudimos leer la hoja. Revisá que siga publicada como CSV y probá de nuevo.',
        code,
      });
    }
    try {
      const result = await this.importSheet(businessId, userId, text);
      await this.markSynced(businessId, null);
      this.logger.log(
        JSON.stringify({
          event: 'catalog_sheet_sync',
          businessId,
          userId,
          outcome: result.outcome,
        }),
      );
      return result;
    } catch (error) {
      // An unusable sheet (no headers, no name column): a person fixes it.
      const code =
        error instanceof BadRequestException ? 'sheet_invalid' : 'sync_failed';
      await this.markSynced(businessId, code);
      throw error;
    }
  }

  private async importSheet(
    businessId: string,
    userId: string | null,
    text: string,
  ): Promise<SyncResult> {
    const parsed = this.catalog.parseSource({ kind: 'csv', text });
    const resolved = await this.catalog.resolveMapping(
      businessId,
      parsed.headers,
      parsed.records,
      undefined,
    );
    // The sheet did not change since the preview a person has to review:
    // keep that one, so a confirmation in progress is not lost.
    const pending = await this.prisma.catalogImport.findFirst({
      where: {
        businessId,
        source: CatalogImportSource.SHEET,
        status: CatalogImportStatus.PREVIEW,
        createdAt: { gte: new Date(Date.now() - PREVIEW_TTL_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (
      pending &&
      // jsonb does not keep key order: compare by value.
      isDeepStrictEqual(pending.sourceRecords, {
        records: parsed.records,
        rows: parsed.rows,
      })
    ) {
      return {
        outcome: 'preview',
        import: await this.catalog.getImport(businessId, pending.id),
      };
    }
    await this.prisma.catalogImport.updateMany({
      where: {
        businessId,
        source: CatalogImportSource.SHEET,
        status: CatalogImportStatus.PREVIEW,
      },
      data: {
        status: CatalogImportStatus.DISCARDED,
        rows: Prisma.DbNull,
        sourceRecords: Prisma.DbNull,
      },
    });
    const preview = await this.catalog.createPreview(businessId, userId, {
      source: CatalogImportSource.SHEET,
      ...parsed,
      ...resolved,
    });
    const { summary } = preview;
    if (
      preview.mappingConfirmed &&
      summary.errors === 0 &&
      summary.created + summary.updated + summary.unavailable === 0
    ) {
      // Nothing to change: no import is kept for it.
      await this.prisma.catalogImport.delete({ where: { id: preview.id } });
      return { outcome: 'unchanged' };
    }
    const availableNow = await this.prisma.catalogItem.count({
      where: { businessId, available: true },
    });
    if (
      !canApplyAlone({
        mappingConfirmed: preview.mappingConfirmed,
        errors: summary.errors,
        unavailable: summary.unavailable,
        availableNow,
      })
    ) {
      return { outcome: 'preview', import: preview };
    }
    try {
      return {
        outcome: 'applied',
        import: await this.catalog.apply(businessId, preview.id, userId),
      };
    } catch (error) {
      // Over the item cap: it stays as a preview for a person.
      if (error instanceof ConflictException) {
        return { outcome: 'preview', import: preview };
      }
      throw error;
    }
  }

  private async markSynced(
    businessId: string,
    error: string | null,
  ): Promise<void> {
    await this.prisma.business.update({
      where: { id: businessId },
      data: { catalogSyncedAt: new Date(), catalogSyncError: error },
    });
  }
}
