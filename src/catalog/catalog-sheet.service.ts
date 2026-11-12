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
  type CatalogRef,
  type CatalogSheetState,
  sheetState,
} from './catalogs.service.js';
import {
  SHEET_FETCHER,
  SheetFetchError,
  type SheetFetcher,
} from './sheet-fetcher.js';

/** How often a catalog's sheet is read again. */
export const SYNC_INTERVAL_MS = 60 * 60_000;

export type SheetView = CatalogSheetState;

export type SyncResult =
  /** The sheet has no changes: no import is created. */
  | { outcome: 'unchanged' }
  | { outcome: 'applied'; import: ImportView }
  /** Waits for a person: row errors, an unconfirmed mapping, >30% gone. */
  | { outcome: 'preview'; import: ImportView };

/**
 * A catalog's Google Sheet published as CSV: stored, read every hour by the
 * scheduler or on demand, and imported into that catalog through the same
 * process as a file. A sync applies by itself only when it is safe (see
 * canApplyAlone, counted on the catalog's items).
 */
@Injectable()
export class CatalogSheetService {
  private readonly logger = new Logger(CatalogSheetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(SHEET_FETCHER) private readonly fetchSheet: SheetFetcher,
  ) {}

  async get(ref: CatalogRef): Promise<SheetView> {
    const catalog = await this.prisma.catalog.findFirst({
      where: { id: ref.catalogId, businessId: ref.businessId },
    });
    if (!catalog) {
      throw new NotFoundException('Catalog not found');
    }
    return sheetState(catalog);
  }

  /**
   * Sets (due now) or removes the sheet. 400 for anything but a sheet
   * published as CSV.
   */
  async set(ref: CatalogRef, url: string | null): Promise<SheetView> {
    if (url !== null && !isPublishedSheetCsvUrl(url)) {
      throw new BadRequestException(
        'El link tiene que ser una hoja de Google publicada como CSV (Archivo → Compartir → Publicar en la web → CSV).',
      );
    }
    await this.get(ref);
    await this.prisma.catalog.update({
      where: { id: ref.catalogId },
      data: {
        sheetUrl: url,
        syncNextAt: url ? new Date() : null,
        syncError: null,
      },
    });
    return this.get(ref);
  }

  /**
   * Reads the sheet and imports it into its catalog. A newer sync discards
   * the catalog's older pending sheet preview. `userId` is who asked (null:
   * scheduled). 409 without a sheet; 502 when it cannot be downloaded.
   */
  async sync(ref: CatalogRef, userId: string | null): Promise<SyncResult> {
    const { url } = await this.get(ref);
    if (!url) {
      throw new ConflictException({
        message: 'El catálogo no tiene una hoja de Google cargada.',
        code: 'NO_SHEET',
      });
    }
    const { businessId, catalogId } = ref;
    let text: string;
    try {
      text = await this.fetchSheet(url);
    } catch (error) {
      const code =
        error instanceof SheetFetchError ? error.code : 'sheet_unexpected';
      await this.markSynced(ref, code);
      this.logger.warn(
        `Sheet sync failed business=${businessId} catalog=${catalogId} code=${code}`,
      );
      throw new BadGatewayException({
        message:
          'No pudimos leer la hoja. Revisá que siga publicada como CSV y probá de nuevo.',
        code,
      });
    }
    try {
      const result = await this.importSheet(ref, userId, text);
      await this.markSynced(ref, null);
      this.logger.log(
        JSON.stringify({
          event: 'catalog_sheet_sync',
          businessId,
          catalogId,
          userId,
          outcome: result.outcome,
        }),
      );
      return result;
    } catch (error) {
      // An unusable sheet (no headers, no name column): a person fixes it.
      const code =
        error instanceof BadRequestException ? 'sheet_invalid' : 'sync_failed';
      await this.markSynced(ref, code);
      throw error;
    }
  }

  private async importSheet(
    ref: CatalogRef,
    userId: string | null,
    text: string,
  ): Promise<SyncResult> {
    const parsed = this.catalog.parseSource({ kind: 'csv', text });
    const resolved = await this.catalog.resolveMapping(
      ref,
      parsed.headers,
      parsed.records,
      undefined,
    );
    // The sheet did not change since the preview a person has to review:
    // keep that one, so a confirmation in progress is not lost.
    const pending = await this.prisma.catalogImport.findFirst({
      where: {
        ...ref,
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
        import: await this.catalog.getImport(ref, pending.id),
      };
    }
    await this.prisma.catalogImport.updateMany({
      where: {
        ...ref,
        source: CatalogImportSource.SHEET,
        status: CatalogImportStatus.PREVIEW,
      },
      data: {
        status: CatalogImportStatus.DISCARDED,
        rows: Prisma.DbNull,
        sourceRecords: Prisma.DbNull,
      },
    });
    const preview = await this.catalog.createPreview(ref, userId, {
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
    // The 30% guard counts this catalog's items, not the business's.
    const availableNow = await this.prisma.catalogItem.count({
      where: { catalogId: ref.catalogId, available: true },
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
        import: await this.catalog.apply(ref, preview.id, userId),
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
    ref: CatalogRef,
    error: string | null,
  ): Promise<void> {
    await this.prisma.catalog.update({
      where: { id: ref.catalogId },
      data: { syncedAt: new Date(), syncError: error },
    });
  }
}
