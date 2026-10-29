import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { z } from 'zod';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import { catalogMappingSchema, MAX_ATTRIBUTES } from './catalog-import.js';
import type { ImportSource } from './catalog.service.js';

/** CSV uploads up to 2 MB (configureHttp registers the text/csv parser). */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
/** Rows per JSON import. */
const MAX_JSON_ROWS = 5_000;

const sourceValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const rowsBodySchema = z
  .object({
    rows: z.array(z.record(z.string(), sourceValue)).min(1).max(MAX_JSON_ROWS),
    mapping: catalogMappingSchema.optional(),
  })
  .strict();

export const importIdSchema = z.uuid();
export const externalIdSchema = z.string().trim().min(1).max(100);

export const itemBodySchema = z
  .object({
    name: z.string(),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    price: z.union([z.number(), z.string(), z.null()]).optional(),
    currency: z.string().nullable().optional(),
    available: z.union([z.boolean(), z.string(), z.null()]).optional(),
    attributes: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .refine((a) => Object.keys(a).length <= MAX_ATTRIBUTES, {
        message: `at most ${MAX_ATTRIBUTES} attributes`,
      })
      .optional(),
  })
  .strict();

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const itemsQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(100).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    available: booleanQuery.optional(),
    cursor: z.uuid().optional(),
  })
  .strict();

/**
 * The import source of a request: a `text/csv` body with the mapping as JSON
 * in `?mapping=`, or a JSON body `{ rows, mapping }`. Only these two types
 * are accepted, so a cross-site form cannot post one without CORS approval.
 */
export function parseImportRequest(
  contentType: string | undefined,
  body: unknown,
  mappingQuery: unknown,
): ImportSource {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  if (type === 'text/csv') {
    if (typeof body !== 'string' || body.trim() === '') {
      throw new BadRequestException('El archivo está vacío.');
    }
    return {
      kind: 'csv',
      text: body,
      ...(mappingQuery === undefined
        ? {}
        : { mapping: parseMappingQuery(mappingQuery) }),
    };
  }
  if (type === 'application/json') {
    if (mappingQuery !== undefined) {
      throw new BadRequestException('Send the mapping in the JSON body');
    }
    const { rows, mapping } = parseOrBadRequest(
      rowsBodySchema,
      body ?? {},
      'body',
    );
    return { kind: 'rows', rows, ...(mapping ? { mapping } : {}) };
  }
  throw new UnsupportedMediaTypeException('Send text/csv or application/json');
}

function parseMappingQuery(
  value: unknown,
): z.infer<typeof catalogMappingSchema> {
  let raw: unknown;
  try {
    raw = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    raw = undefined;
  }
  return parseOrBadRequest(catalogMappingSchema, raw, 'mapping');
}
