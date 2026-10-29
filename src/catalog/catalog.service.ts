import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import {
  type CatalogImport,
  CatalogImportSource,
  CatalogImportStatus,
  type CatalogItem,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UTC_NOW } from '../prisma/sql.js';
import type { CatalogReader } from '../bot/tools/tool.js';
import {
  type AttributeValue,
  type CatalogDiff,
  type CatalogItemInput,
  type CatalogMapping,
  cleanCode,
  defaultMapping,
  diffCatalog,
  normalizeAttributes,
  normalizeRow,
  normalizeSource,
  type RowError,
  rowHash,
  type SourceRecord,
} from './catalog-import.js';
import {
  type CatalogDocument,
  CatalogAiService,
  DOCUMENT_COLUMNS,
} from './catalog-ai.service.js';
import { csvRecords } from './csv.js';

/** Previews keep their rows this long; then they can no longer be applied. */
export const PREVIEW_TTL_MS = 24 * 60 * 60_000;
const PAGE_SIZE = 50;
/** Rows per UPDATE statement when applying an import. */
const UPDATE_BATCH = 500;
/** search_catalog returns at most this many items. */
export const SEARCH_LIMIT = 8;
/** Fewer full-text matches than this are completed by name similarity. */
const MIN_TEXT_MATCHES = 3;
const SEARCH_DESCRIPTION_CHARS = 300;
/** Applying thousands of rows is one transaction; give it time. */
const APPLY_TIMEOUT_MS = 60_000;

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  unavailable: number;
  errors: number;
}

export interface ImportView {
  id: string;
  source: 'csv' | 'api' | 'sheet' | 'document';
  status: CatalogImportStatus;
  summary: ImportSummary;
  errors: RowError[];
  /** The source's columns and the mapping used (null for old imports). */
  headers: string[] | null;
  mapping: CatalogMapping | null;
  /** False while a model-proposed mapping waits for a person. */
  mappingConfirmed: boolean;
  createdAt: Date;
  appliedAt: Date | null;
}

/** What search_catalog gives the model for one item. */
export interface CatalogSearchItem {
  name: string;
  description: string;
  category: string | null;
  price: number | null;
  currency: string;
  attributes: Prisma.JsonValue;
}

export interface CatalogSearchQuery {
  query: string;
  category: string | null;
  maxPrice: number | null;
}

interface SearchRow {
  id: string;
  name: string;
  description: string;
  category: string | null;
  price: Prisma.Decimal | null;
  currency: string;
  attributes: Prisma.JsonValue;
}

export interface CatalogItemView {
  externalId: string;
  name: string;
  description: string;
  category: string | null;
  /** Two decimals as text ("1500.00"); null without a price. */
  price: string | null;
  currency: string;
  available: boolean;
  attributes: Prisma.JsonValue;
  updatedAt: Date;
}

/** One source to import: a CSV file, rows sent as JSON, or a document. */
export type ImportSource =
  | { kind: 'csv'; text: string; mapping?: CatalogMapping }
  | { kind: 'rows'; rows: SourceRecord[]; mapping?: CatalogMapping }
  | { kind: 'document'; document: CatalogDocument; mapping?: undefined };

/** Source records of a preview and their row numbers. */
interface StoredRecords {
  records: SourceRecord[];
  rows: number[];
}

/** business.catalog_mapping. */
interface SavedMapping {
  headers: string[];
  mapping: CatalogMapping;
}

/** A single-item write (PUT .../items/:externalId). */
export interface ItemBody {
  name: string;
  description?: string | null;
  category?: string | null;
  price?: string | number | null;
  currency?: string | null;
  available?: string | boolean | null;
  attributes?: Record<string, AttributeValue>;
}

const SOURCE_LABEL: Record<CatalogImportSource, ImportView['source']> = {
  CSV: 'csv',
  API: 'api',
  SHEET: 'sheet',
  DOCUMENT: 'document',
};

const notFound = () => new NotFoundException('Import not found');

function itemView(item: CatalogItem): CatalogItemView {
  return {
    externalId: item.externalId,
    name: item.name,
    description: item.description,
    category: item.category,
    price: item.price === null ? null : item.price.toFixed(2),
    currency: item.currency,
    available: item.available,
    attributes: item.attributes,
    updatedAt: item.updatedAt,
  };
}

/** A stored item back in the import model (to rehash it). */
function asInput(item: CatalogItem): CatalogItemInput {
  return {
    externalId: item.externalId,
    name: item.name,
    description: item.description,
    category: item.category,
    price: item.price === null ? null : item.price.toFixed(2),
    currency: item.currency,
    available: item.available,
    attributes: item.attributes as CatalogItemInput['attributes'],
  };
}

function itemData(item: CatalogItemInput) {
  return {
    externalId: item.externalId,
    name: item.name,
    description: item.description,
    category: item.category,
    price: item.price,
    currency: item.currency,
    available: item.available,
    attributes: item.attributes,
    rowHash: rowHash(item),
  };
}

function summaryOf(diff: CatalogDiff, errors: number): ImportSummary {
  return {
    created: diff.created.length,
    updated: diff.updated.length,
    unchanged: diff.unchanged,
    unavailable: diff.unavailable.length,
    errors,
  };
}

function capExceeded(cap: number): ConflictException {
  return new ConflictException({
    message: `El catálogo superaría el tope de ${cap} ítems disponibles.`,
    code: 'CATALOG_CAP_EXCEEDED',
  });
}

/**
 * A business's catalog: every source goes through the same import (preview,
 * then apply), and single items can be written by their code. Every query
 * filters by businessId.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly ai: CatalogAiService,
  ) {}

  /** Normalizes and validates the source and stores a preview. */
  async preview(
    businessId: string,
    source: ImportSource,
    createdById: string | null,
  ): Promise<ImportView> {
    await this.assertBusiness(businessId);
    if (source.kind === 'document') {
      const records = await this.ai.extractRows(businessId, source.document);
      return this.createPreview(businessId, createdById, {
        source: CatalogImportSource.DOCUMENT,
        headers: Object.values(DOCUMENT_COLUMNS),
        records,
        rows: records.map((_, index) => index + 1),
        mapping: DOCUMENT_COLUMNS,
        confirmed: true,
      });
    }
    const parsed = this.parseSource(source);
    const resolved = await this.resolveMapping(
      businessId,
      parsed.headers,
      parsed.records,
      source.mapping,
    );
    return this.createPreview(businessId, createdById, {
      source:
        source.kind === 'csv'
          ? CatalogImportSource.CSV
          : CatalogImportSource.API,
      ...parsed,
      ...resolved,
    });
  }

  /**
   * Confirms or corrects the mapping of a preview: its rows are normalized
   * again from the stored source records, and the mapping is saved for the
   * next imports with these headers.
   */
  async confirmMapping(
    businessId: string,
    importId: string,
    mapping: CatalogMapping,
    now = new Date(),
  ): Promise<ImportView> {
    const found = await this.openImport(this.prisma, businessId, importId, now);
    if (found.source === CatalogImportSource.DOCUMENT || !found.sourceRecords) {
      throw new ConflictException({
        message: 'Esta importación no tiene columnas para mapear.',
        code: 'NO_MAPPING',
      });
    }
    const headers = found.headers as string[];
    assertColumns(mapping, headers);
    const records = found.sourceRecords as unknown as StoredRecords;
    const normalized = normalizeSource(records.records, mapping, records.rows);
    const diff = await this.diffWith(businessId, normalized.items);
    await this.saveMapping(businessId, headers, mapping);
    return this.importView(
      await this.prisma.catalogImport.update({
        where: { id: found.id },
        data: {
          mapping,
          mappingConfirmed: true,
          summary: { ...summaryOf(diff, normalized.errorCount) },
          rowErrors: normalized.errors as unknown as Prisma.InputJsonValue,
          rows: normalized.items as unknown as Prisma.InputJsonValue,
        },
      }),
    );
  }

  /**
   * Applies a preview in one transaction against the current catalog:
   * creates and updates by code, and marks unavailable (never deletes) what
   * the source no longer has. 409 CATALOG_CAP_EXCEEDED applies nothing.
   */
  async apply(
    businessId: string,
    importId: string,
    userId: string | null,
    now = new Date(),
  ): Promise<ImportView> {
    const applied = await this.prisma.$transaction(
      async (tx) => {
        const cap = await this.lockBusiness(tx, businessId);
        const found = await this.openImport(tx, businessId, importId, now);
        if (!found.mappingConfirmed) {
          throw new ConflictException({
            message:
              'Confirmá o corregí el mapeo de columnas antes de aplicar la importación.',
            code: 'MAPPING_NOT_CONFIRMED',
          });
        }
        const items = found.rows as unknown as CatalogItemInput[];
        const existing = await tx.catalogItem.findMany({
          where: { businessId },
        });
        const diff = diffCatalog(existing, items);
        // Every item the source lacks becomes unavailable, so the source
        // alone tells how many stay available.
        if (items.filter((i) => i.available).length > cap) {
          throw capExceeded(cap);
        }
        if (diff.created.length > 0) {
          await tx.catalogItem.createMany({
            data: diff.created.map((item) => ({
              businessId,
              ...itemData(item),
            })),
          });
        }
        const gone = new Set(diff.unavailable);
        await updateItems(tx, businessId, [
          ...diff.updated,
          ...existing
            .filter((i) => gone.has(i.externalId))
            .map((i) => ({ ...asInput(i), available: false })),
        ]);
        return tx.catalogImport.update({
          where: { id: found.id },
          data: {
            status: CatalogImportStatus.APPLIED,
            appliedAt: now,
            rows: Prisma.DbNull,
            sourceRecords: Prisma.DbNull,
            summary: {
              ...summaryOf(
                diff,
                (found.summary as unknown as ImportSummary).errors,
              ),
            },
          },
        });
      },
      { timeout: APPLY_TIMEOUT_MS },
    );
    const view = this.importView(applied);
    this.logger.log(
      JSON.stringify({
        event: 'catalog_import_applied',
        businessId,
        userId,
        importId,
        summary: view.summary,
      }),
    );
    return view;
  }

  async discard(businessId: string, importId: string): Promise<ImportView> {
    const found = await this.prisma.catalogImport.findFirst({
      where: { id: importId, businessId },
    });
    if (!found) {
      throw notFound();
    }
    if (found.status !== CatalogImportStatus.PREVIEW) {
      throw notPreview();
    }
    return this.importView(
      await this.prisma.catalogImport.update({
        where: { id: found.id },
        data: {
          status: CatalogImportStatus.DISCARDED,
          rows: Prisma.DbNull,
          sourceRecords: Prisma.DbNull,
        },
      }),
    );
  }

  async getImport(businessId: string, importId: string): Promise<ImportView> {
    const found = await this.prisma.catalogImport.findFirst({
      where: { id: importId, businessId },
    });
    if (!found) {
      throw notFound();
    }
    return this.importView(found);
  }

  /**
   * Creates or updates one item by its code (a client's own system). Without
   * `available`, an existing item keeps its availability (a price update
   * does not bring back a sold-out item); a new one is available.
   */
  async putItem(
    businessId: string,
    rawExternalId: string,
    body: ItemBody,
  ): Promise<CatalogItemView> {
    const externalId = cleanCode(rawExternalId);
    if (!externalId) {
      throw new BadRequestException('Falta el código.');
    }
    const { attributes, ...fields } = body;
    const record: SourceRecord = { ...fields, externalId };
    const mapping: CatalogMapping = {
      externalId: 'externalId',
      name: 'name',
      description: 'description',
      category: 'category',
      price: 'price',
      currency: 'currency',
      available: 'available',
    };
    const result = normalizeRow(record, mapping, 1);
    if (!result.ok) {
      throw new BadRequestException(
        result.error.message.replace(/^Fila 1: /, ''),
      );
    }
    const extra = normalizeAttributes(attributes ?? {});
    if (!extra.ok) {
      throw new BadRequestException(extra.message);
    }
    return this.prisma.$transaction(async (tx) => {
      const cap = await this.lockBusiness(tx, businessId);
      const current = await tx.catalogItem.findUnique({
        where: { businessId_externalId: { businessId, externalId } },
      });
      const item: CatalogItemInput = {
        ...result.item,
        attributes: extra.attributes,
        available:
          body.available === undefined && current
            ? current.available
            : result.item.available,
      };
      if (item.available && !current?.available) {
        const available = await tx.catalogItem.count({
          where: { businessId, available: true },
        });
        if (available + 1 > cap) {
          throw capExceeded(cap);
        }
      }
      const saved = current
        ? current.rowHash === rowHash(item)
          ? current
          : await tx.catalogItem.update({
              where: { id: current.id },
              data: itemData(item),
            })
        : await tx.catalogItem.create({
            data: { businessId, ...itemData(item) },
          });
      return itemView(saved);
    });
  }

  /** Marks the item unavailable (items are never deleted). */
  async removeItem(
    businessId: string,
    rawExternalId: string,
  ): Promise<CatalogItemView> {
    const externalId = cleanCode(rawExternalId);
    const current = await this.prisma.catalogItem.findUnique({
      where: { businessId_externalId: { businessId, externalId } },
    });
    if (!current) {
      throw new NotFoundException('Item not found');
    }
    if (!current.available) {
      return itemView(current);
    }
    return itemView(
      await this.prisma.catalogItem.update({
        where: { id: current.id },
        data: itemData({ ...asInput(current), available: false }),
      }),
    );
  }

  /** 50 per page, by name; `query` matches code, name or description. */
  async listItems(
    businessId: string,
    filters: {
      query?: string;
      category?: string;
      available?: boolean;
      cursor?: string;
    },
  ): Promise<{ items: CatalogItemView[]; nextCursor: string | null }> {
    await this.assertBusiness(businessId);
    const where: Prisma.CatalogItemWhereInput = {
      businessId,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.available === undefined
        ? {}
        : { available: filters.available }),
      ...(filters.query
        ? {
            OR: (['externalId', 'name', 'description'] as const).map((f) => ({
              [f]: { contains: filters.query, mode: 'insensitive' as const },
            })),
          }
        : {}),
    };
    const rows = await this.prisma.catalogItem.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 0 } : {}),
    });
    const page = rows.slice(0, PAGE_SIZE);
    return {
      items: page.map(itemView),
      nextCursor: rows.length > PAGE_SIZE ? rows[PAGE_SIZE]!.id : null,
    };
  }

  /**
   * The bot's read access to the business's catalog, or undefined when it
   * has no available item (then search_catalog is not offered).
   */
  async readerFor(businessId: string): Promise<CatalogReader | undefined> {
    if (!(await this.hasAvailable(businessId))) {
      return undefined;
    }
    return { search: (query) => this.search(businessId, query) };
  }

  /** Whether the business has an available item (search_catalog offered). */
  async hasAvailable(businessId: string): Promise<boolean> {
    const item = await this.prisma.catalogItem.findFirst({
      where: { businessId, available: true },
      select: { id: true },
    });
    return item !== null;
  }

  /**
   * Up to {@link SEARCH_LIMIT} available items of the business by relevance:
   * full-text search (Spanish, accent-insensitive), completed by name
   * similarity (pg_trgm, typo tolerant) when it finds fewer than 3. Reads
   * only.
   */
  async search(
    businessId: string,
    { query, category, maxPrice }: CatalogSearchQuery,
  ): Promise<CatalogSearchItem[]> {
    const filters = Prisma.sql`business_id = ${businessId}::uuid AND available
      AND (${category}::text IS NULL
        OR lower(unaccent(category)) = lower(unaccent(${category}::text)))
      AND (${maxPrice}::numeric IS NULL OR price <= ${maxPrice}::numeric)`;
    const columns = Prisma.sql`id, name, description, category, price, currency, attributes`;
    const matches = await this.prisma.$queryRaw<SearchRow[]>`
      SELECT ${columns}
      FROM catalog_item,
        websearch_to_tsquery('public.spanish_unaccent', ${query}) AS q
      WHERE ${filters} AND search @@ q
      ORDER BY ts_rank(search, q) DESC, name
      LIMIT ${SEARCH_LIMIT}`;
    if (matches.length < MIN_TEXT_MATCHES) {
      const found = matches.map((m) => m.id);
      const similar = await this.prisma.$queryRaw<SearchRow[]>`
        SELECT ${columns}
        FROM catalog_item
        WHERE ${filters} AND name % ${query}
          AND NOT (id = ANY(${found}::uuid[]))
        ORDER BY similarity(name, ${query}) DESC, name
        LIMIT ${SEARCH_LIMIT - matches.length}`;
      matches.push(...similar);
    }
    return matches.map((row) => ({
      name: row.name,
      description: Array.from(row.description)
        .slice(0, SEARCH_DESCRIPTION_CHARS)
        .join(''),
      category: row.category,
      price: row.price === null ? null : Number(row.price),
      currency: row.currency,
      attributes: row.attributes,
    }));
  }

  /**
   * Normalizes, diffs and stores a preview (also the sheet sync's). Keeps
   * the source records until apply, discard or 24 hours, for a mapping fix.
   */
  async createPreview(
    businessId: string,
    createdById: string | null,
    input: {
      source: CatalogImportSource;
      headers: string[];
      records: SourceRecord[];
      rows: number[];
      mapping: CatalogMapping;
      confirmed: boolean;
    },
  ): Promise<ImportView> {
    const normalized = normalizeSource(
      input.records,
      input.mapping,
      input.rows,
    );
    const diff = await this.diffWith(businessId, normalized.items);
    await this.purgeExpired();
    const stored: StoredRecords = { records: input.records, rows: input.rows };
    const created = await this.prisma.catalogImport.create({
      data: {
        businessId,
        source: input.source,
        summary: { ...summaryOf(diff, normalized.errorCount) },
        rowErrors: normalized.errors as unknown as Prisma.InputJsonValue,
        rows: normalized.items as unknown as Prisma.InputJsonValue,
        sourceRecords: stored as unknown as Prisma.InputJsonValue,
        headers: input.headers,
        mapping: input.mapping,
        mappingConfirmed: input.confirmed,
        createdById,
      },
    });
    return this.importView(created);
  }

  /**
   * The mapping of a source, in order: the one given (a person chose it, so
   * it is saved), the saved one when the headers did not change, the known
   * headers when they include the name and the price, a pending proposal
   * for these headers, the model's proposal (unconfirmed: a person must
   * confirm it before apply), or the known headers when the model is not
   * available. 400 without a name column.
   */
  async resolveMapping(
    businessId: string,
    headers: string[],
    records: readonly SourceRecord[],
    given: CatalogMapping | undefined,
  ): Promise<{ mapping: CatalogMapping; confirmed: boolean }> {
    if (given) {
      assertColumns(given, headers);
      await this.saveMapping(businessId, headers, given);
      return { mapping: given, confirmed: true };
    }
    const saved = await this.savedMapping(businessId, headers);
    if (saved) {
      return { mapping: saved, confirmed: true };
    }
    // Known name and price columns need no model and no confirmation (as
    // before the model existed); the rest of the known ones come along.
    const known = defaultMapping(headers);
    if (known?.price) {
      return { mapping: known, confirmed: true };
    }
    // A proposal already waiting for a person with these same headers is
    // reused: the model is asked once per set of headers, not every sync.
    const pending = await this.pendingProposal(businessId, headers);
    if (pending) {
      return { mapping: pending, confirmed: false };
    }
    const proposed = await this.ai.proposeMapping(businessId, headers, records);
    if (proposed) {
      return { mapping: proposed, confirmed: false };
    }
    const guessed = known;
    if (!guessed) {
      throw new BadRequestException(
        'No encontramos la columna del nombre: indicá el mapeo de columnas (mapping.name).',
      );
    }
    return { mapping: guessed, confirmed: true };
  }

  /** The newest unexpired, unconfirmed proposal for these same headers. */
  private async pendingProposal(
    businessId: string,
    headers: readonly string[],
    now = new Date(),
  ): Promise<CatalogMapping | null> {
    const candidates = await this.prisma.catalogImport.findMany({
      where: {
        businessId,
        status: CatalogImportStatus.PREVIEW,
        mappingConfirmed: false,
        createdAt: { gte: new Date(now.getTime() - PREVIEW_TTL_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { headers: true, mapping: true },
      take: 10,
    });
    const match = candidates.find((c) =>
      sameHeaders((c.headers as string[] | null) ?? [], headers),
    );
    return (match?.mapping as CatalogMapping | null | undefined) ?? null;
  }

  /** The saved mapping, when it was made for these same headers. */
  async savedMapping(
    businessId: string,
    headers: readonly string[],
  ): Promise<CatalogMapping | null> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { catalogMapping: true },
    });
    const saved = business?.catalogMapping as SavedMapping | null | undefined;
    if (!saved || !sameHeaders(saved.headers, headers)) {
      return null;
    }
    return saved.mapping;
  }

  private async saveMapping(
    businessId: string,
    headers: readonly string[],
    mapping: CatalogMapping,
  ): Promise<void> {
    const saved: SavedMapping = { headers: [...headers], mapping };
    await this.prisma.business.update({
      where: { id: businessId },
      data: { catalogMapping: saved as unknown as Prisma.InputJsonValue },
    });
  }

  private async diffWith(
    businessId: string,
    items: readonly CatalogItemInput[],
  ): Promise<CatalogDiff> {
    return diffCatalog(
      await this.prisma.catalogItem.findMany({
        where: { businessId },
        select: { externalId: true, rowHash: true, available: true },
      }),
      items,
    );
  }

  /** The business's item cap (its own, or CATALOG_MAX_ITEMS_PER_BUSINESS). */
  private async lockBusiness(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<number> {
    // Serializes the writes of one business, so the cap holds.
    const [business] = await tx.$queryRaw<
      Array<{ catalog_item_cap: number | null }>
    >`SELECT catalog_item_cap FROM business WHERE id = ${businessId}::uuid FOR UPDATE`;
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    return (
      business.catalog_item_cap ??
      this.config.get('CATALOG_MAX_ITEMS_PER_BUSINESS')
    );
  }

  private async openImport(
    tx: Prisma.TransactionClient,
    businessId: string,
    importId: string,
    now: Date,
  ): Promise<CatalogImport> {
    const found = await tx.catalogImport.findFirst({
      where: { id: importId, businessId },
    });
    if (!found) {
      throw notFound();
    }
    if (found.status !== CatalogImportStatus.PREVIEW) {
      throw notPreview();
    }
    if (
      found.rows === null ||
      now.getTime() - found.createdAt.getTime() > PREVIEW_TTL_MS
    ) {
      throw new ConflictException({
        message: 'La vista previa venció: volvé a importar el archivo.',
        code: 'IMPORT_EXPIRED',
      });
    }
    return found;
  }

  /** Previews older than 24 hours lose their rows. */
  private async purgeExpired(now = new Date()): Promise<void> {
    await this.prisma.catalogImport.updateMany({
      where: {
        status: CatalogImportStatus.PREVIEW,
        createdAt: { lt: new Date(now.getTime() - PREVIEW_TTL_MS) },
        NOT: { rows: { equals: Prisma.DbNull } },
      },
      data: { rows: Prisma.DbNull, sourceRecords: Prisma.DbNull },
    });
  }

  /** Headers, records and row numbers of a CSV or of JSON rows. */
  parseSource(source: Extract<ImportSource, { kind: 'csv' | 'rows' }>): {
    headers: string[];
    records: SourceRecord[];
    rows: number[];
  } {
    if (source.kind === 'rows') {
      return {
        headers: [...new Set(source.rows.flatMap((r) => Object.keys(r)))],
        records: source.rows,
        rows: source.rows.map((_, index) => index + 1),
      };
    }
    // Spreadsheet rows: the header is row 1, blank rows still count.
    const { headers, records, rows } = csvRecords(source.text);
    if (headers.length === 0 || headers.every((h) => h === '')) {
      throw new BadRequestException(
        'El archivo está vacío o no tiene encabezados.',
      );
    }
    const repeated = headers.find(
      (h, i) => h !== '' && headers.indexOf(h) !== i,
    );
    if (repeated !== undefined) {
      throw new BadRequestException(
        `La columna "${repeated}" está repetida en los encabezados.`,
      );
    }
    return { headers, records, rows };
  }

  private async assertBusiness(businessId: string): Promise<void> {
    const exists = await this.prisma.business.count({
      where: { id: businessId },
    });
    if (!exists) {
      throw new NotFoundException('Business not found');
    }
  }

  private importView(found: CatalogImport): ImportView {
    return {
      id: found.id,
      source: SOURCE_LABEL[found.source],
      status: found.status,
      summary: found.summary as unknown as ImportSummary,
      errors: found.rowErrors as unknown as RowError[],
      headers: found.headers as string[] | null,
      mapping: found.mapping as CatalogMapping | null,
      mappingConfirmed: found.mappingConfirmed,
      createdAt: found.createdAt,
      appliedAt: found.appliedAt,
    };
  }
}

function notPreview(): ConflictException {
  return new ConflictException({
    message: 'Esta importación ya se aplicó o se descartó.',
    code: 'IMPORT_NOT_PREVIEW',
  });
}

/**
 * Updates existing items by code, {@link UPDATE_BATCH} rows per statement
 * (one round trip each instead of one per item).
 */
async function updateItems(
  tx: Prisma.TransactionClient,
  businessId: string,
  items: readonly CatalogItemInput[],
): Promise<void> {
  for (let start = 0; start < items.length; start += UPDATE_BATCH) {
    const values = items.slice(start, start + UPDATE_BATCH).map(
      (item) => Prisma.sql`(
        ${item.externalId}::text, ${item.name}::text, ${item.description}::text,
        ${item.category}::text, ${item.price}::numeric, ${item.currency}::text,
        ${item.available}::boolean, ${JSON.stringify(item.attributes)}::jsonb,
        ${rowHash(item)}::text)`,
    );
    await tx.$executeRaw`
      UPDATE catalog_item AS c SET
        name = v.name, description = v.description, category = v.category,
        price = v.price, currency = v.currency, available = v.available,
        attributes = v.attributes, row_hash = v.row_hash,
        updated_at = ${UTC_NOW}
      FROM (VALUES ${Prisma.join(values)}) AS v(external_id, name,
        description, category, price, currency, available, attributes, row_hash)
      WHERE c.business_id = ${businessId}::uuid
        AND c.external_id = v.external_id`;
  }
}

/** 400 when the mapping names a column the source does not have. */
function assertColumns(mapping: CatalogMapping, headers: readonly string[]) {
  const missing = Object.values(mapping).filter(
    (column): column is string =>
      column !== undefined && !headers.includes(column),
  );
  if (missing.length > 0) {
    throw new BadRequestException(
      `El mapeo usa columnas que no están en el archivo: ${missing.map((c) => `"${c}"`).join(', ')}.`,
    );
  }
}

/** The same columns, in any order. */
function sameHeaders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((h) => b.includes(h));
}
