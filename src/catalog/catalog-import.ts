import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Catalog fields a source column can be mapped to. */
export const CATALOG_FIELDS = [
  'externalId',
  'name',
  'description',
  'category',
  'price',
  'currency',
  'available',
] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number];

/**
 * Which source column feeds each field (by header). Columns not mapped to a
 * field go to `attributes`. `name` is the only required field.
 */
export type CatalogMapping = Partial<Record<CatalogField, string>> & {
  name: string;
};

export const MAX_ATTRIBUTES = 20;
export const MAX_ROW_ERRORS = 200;
const MAX_NAME = 200;
const MAX_EXTERNAL_ID = 100;
const MAX_DESCRIPTION = 2000;
const MAX_CATEGORY = 100;
const MAX_ATTRIBUTE_TEXT = 200;
const MAX_PRICE = 9_999_999_999.99;

const column = z.string().trim().min(1).max(100);

/** A mapping as the routes receive it (unknown fields rejected). */
export const catalogMappingSchema = z
  .object({
    externalId: column.optional(),
    name: column,
    description: column.optional(),
    category: column.optional(),
    price: column.optional(),
    currency: column.optional(),
    available: column.optional(),
  })
  .strict();

/** A source value: CSV gives text, a JSON body may give numbers or booleans. */
export type SourceValue = string | number | boolean | null;
export type SourceRecord = Record<string, SourceValue>;

export type AttributeValue = string | number | boolean;

/** A valid row, normalized to the catalog_item model. */
export interface CatalogItemInput {
  externalId: string;
  name: string;
  description: string;
  category: string | null;
  /** Two decimals, as a string ("1500.00"), never a float; null: no price. */
  price: string | null;
  currency: string;
  available: boolean;
  attributes: Record<string, AttributeValue>;
}

export interface RowError {
  /** Row number as the person sees it (the CSV header is row 1). */
  row: number;
  message: string;
}

/** Lowercase, without accents, single spaces: the code of a row without one. */
export function deriveExternalId(name: string): string {
  return stripAccents(name).toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

// Control characters become spaces; one line of text.
const oneLine = (value: string) =>
  value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * "$ 1.500,00" → "1500.00". Comma is the decimal separator unless a dot comes
 * after it ("1,500.00"); a lone dot is a thousands separator only in groups
 * of three ("1.500", "12.000.000"). Throws when it is not a number.
 */
export function parsePrice(value: SourceValue): string | null {
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  if (typeof value === 'boolean') {
    throw new Error('not a number');
  }
  let amount: number;
  if (typeof value === 'number') {
    amount = value;
  } else {
    let text = value.replace(/\$|ARS|\s/gi, '');
    const comma = text.lastIndexOf(',');
    const dot = text.lastIndexOf('.');
    if (comma >= 0 && dot > comma) {
      text = text.replace(/,/g, '');
    } else if (comma >= 0) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, '');
    }
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new Error('not a number');
    }
    amount = Number(text);
  }
  if (!Number.isFinite(amount)) {
    throw new Error('not a number');
  }
  if (amount < 0) {
    throw new Error('negative');
  }
  if (amount > MAX_PRICE) {
    throw new Error('too large');
  }
  return amount.toFixed(2);
}

const AVAILABLE = new Set(['si', 's', '1', 'true', 'disponible', 'yes']);
const UNAVAILABLE = new Set(['no', 'n', '0', 'false', 'agotado']);

/** sí/no/1/0/true/false/disponible/agotado; blank means available. */
export function parseAvailability(value: SourceValue): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = stripAccents(String(value)).trim().toLowerCase();
  if (text === '' || AVAILABLE.has(text)) {
    return true;
  }
  if (UNAVAILABLE.has(text)) {
    return false;
  }
  throw new Error('unknown availability');
}

const text = (value: SourceValue | undefined): string =>
  value === null || value === undefined ? '' : oneLine(String(value));

/**
 * The header of each field when the mapping does not name it: the columns of
 * the sample sheet (codigo, producto, descripcion, categoria, precio,
 * disponible) and common synonyms, compared without accents or case.
 */
const DEFAULT_HEADERS: Record<CatalogField, readonly string[]> = {
  externalId: ['codigo', 'sku', 'id', 'cod'],
  name: ['producto', 'nombre', 'servicio', 'item', 'articulo'],
  description: ['descripcion', 'detalle'],
  category: ['categoria', 'rubro', 'tipo'],
  price: ['precio', 'valor', 'importe'],
  currency: ['moneda'],
  available: ['disponible', 'disponibilidad', 'stock'],
};

/** The mapping guessed from the headers; null when no column is the name. */
export function defaultMapping(
  headers: readonly string[],
): CatalogMapping | null {
  const key = (h: string) => stripAccents(h).trim().toLowerCase();
  const mapping: Partial<Record<CatalogField, string>> = {};
  for (const field of CATALOG_FIELDS) {
    const header = headers.find((h) => DEFAULT_HEADERS[field].includes(key(h)));
    if (header !== undefined) {
      mapping[field] = header;
    }
  }
  return mapping.name ? (mapping as CatalogMapping) : null;
}

/**
 * Normalizes and validates one row. Errors are in Spanish, for the person
 * importing ("Fila 22: falta el nombre.").
 */
export function normalizeRow(
  record: SourceRecord,
  mapping: CatalogMapping,
  row: number,
): { ok: true; item: CatalogItemInput } | { ok: false; error: RowError } {
  const fail = (message: string) => ({
    ok: false as const,
    error: { row, message: `Fila ${row}: ${message}` },
  });
  const value = (field: CatalogField) => {
    const column = mapping[field];
    return column === undefined ? undefined : record[column];
  };

  const name = text(value('name'));
  if (!name) {
    return fail('falta el nombre.');
  }
  if (name.length > MAX_NAME) {
    return fail(`el nombre tiene más de ${MAX_NAME} caracteres.`);
  }
  const externalId = text(value('externalId')) || deriveExternalId(name);
  if (externalId.length > MAX_EXTERNAL_ID) {
    return fail(`el código tiene más de ${MAX_EXTERNAL_ID} caracteres.`);
  }
  const description = text(value('description'));
  if (description.length > MAX_DESCRIPTION) {
    return fail(`la descripción tiene más de ${MAX_DESCRIPTION} caracteres.`);
  }
  const category = text(value('category')) || null;
  if (category && category.length > MAX_CATEGORY) {
    return fail(`la categoría tiene más de ${MAX_CATEGORY} caracteres.`);
  }

  const rawPrice = value('price') ?? null;
  let price: string | null;
  try {
    price = parsePrice(rawPrice);
  } catch (error) {
    const reason = (error as Error).message;
    return fail(
      reason === 'negative'
        ? `el precio "${text(rawPrice)}" no puede ser negativo.`
        : reason === 'too large'
          ? `el precio "${text(rawPrice)}" es demasiado grande.`
          : `el precio "${text(rawPrice)}" no es un número.`,
    );
  }

  const currency = (text(value('currency')) || 'ARS').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return fail(
      `la moneda "${currency}" no es un código de 3 letras (por ejemplo, ARS).`,
    );
  }

  const rawAvailable = value('available') ?? null;
  let available: boolean;
  try {
    available = parseAvailability(rawAvailable);
  } catch {
    return fail(
      `la disponibilidad "${text(rawAvailable)}" no se entiende (usá sí o no).`,
    );
  }

  const mapped = new Set<string>(
    Object.values(mapping).filter((c): c is string => c !== undefined),
  );
  const attributes: Record<string, AttributeValue> = {};
  for (const [column, raw] of Object.entries(record)) {
    const key = oneLine(column);
    if (mapped.has(column) || !key || raw === null) {
      continue;
    }
    if (typeof raw === 'string') {
      const clean = oneLine(raw);
      if (!clean) {
        continue;
      }
      if (clean.length > MAX_ATTRIBUTE_TEXT) {
        return fail(`"${key}" tiene más de ${MAX_ATTRIBUTE_TEXT} caracteres.`);
      }
      attributes[key] = clean;
    } else {
      attributes[key] = raw;
    }
  }
  if (Object.keys(attributes).length > MAX_ATTRIBUTES) {
    return fail(`tiene más de ${MAX_ATTRIBUTES} datos extra (atributos).`);
  }

  return {
    ok: true,
    item: {
      externalId,
      name,
      description,
      category,
      price,
      currency,
      available,
      attributes,
    },
  };
}

/** Valid rows and per-row errors of a whole source. */
export interface NormalizedSource {
  items: CatalogItemInput[];
  errors: RowError[];
  /** All errors, also those beyond {@link MAX_ROW_ERRORS}. */
  errorCount: number;
}

/**
 * Normalizes every row; an invalid row is reported and the rest go on. A
 * repeated code keeps its first row. `firstRow` is the number of the first
 * record (2 for a CSV, after its header).
 */
export function normalizeSource(
  records: readonly SourceRecord[],
  mapping: CatalogMapping,
  firstRow: number,
): NormalizedSource {
  const items: CatalogItemInput[] = [];
  const errors: RowError[] = [];
  let errorCount = 0;
  const seen = new Set<string>();
  const report = (error: RowError) => {
    errorCount += 1;
    if (errors.length < MAX_ROW_ERRORS) {
      errors.push(error);
    }
  };
  records.forEach((record, index) => {
    const row = firstRow + index;
    const result = normalizeRow(record, mapping, row);
    if (!result.ok) {
      report(result.error);
      return;
    }
    if (seen.has(result.item.externalId)) {
      report({
        row,
        message: `Fila ${row}: el código "${result.item.externalId}" está repetido en el archivo.`,
      });
      return;
    }
    seen.add(result.item.externalId);
    items.push(result.item);
  });
  return { items, errors, errorCount };
}

/** Hash of every stored field of an item (attribute keys sorted). */
export function rowHash(item: CatalogItemInput): string {
  const attributes = Object.fromEntries(
    Object.entries(item.attributes).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash('sha256')
    .update(
      JSON.stringify([
        item.externalId,
        item.name,
        item.description,
        item.category,
        item.price,
        item.currency,
        item.available,
        attributes,
      ]),
    )
    .digest('hex');
}

export interface ExistingItem {
  externalId: string;
  rowHash: string;
  available: boolean;
}

export interface CatalogDiff {
  created: CatalogItemInput[];
  /** Changed rows, including unavailable items that are back. */
  updated: CatalogItemInput[];
  unchanged: number;
  /** Available items the source no longer has: marked unavailable. */
  unavailable: string[];
}

/** What applying `incoming` over the business's items would change. */
export function diffCatalog(
  existing: readonly ExistingItem[],
  incoming: readonly CatalogItemInput[],
): CatalogDiff {
  const byId = new Map(existing.map((item) => [item.externalId, item]));
  const incomingIds = new Set(incoming.map((item) => item.externalId));
  const diff: CatalogDiff = {
    created: [],
    updated: [],
    unchanged: 0,
    unavailable: [],
  };
  for (const item of incoming) {
    const current = byId.get(item.externalId);
    if (!current) {
      diff.created.push(item);
    } else if (current.rowHash !== rowHash(item)) {
      diff.updated.push(item);
    } else {
      diff.unchanged += 1;
    }
  }
  for (const item of existing) {
    if (item.available && !incomingIds.has(item.externalId)) {
      diff.unavailable.push(item.externalId);
    }
  }
  return diff;
}
