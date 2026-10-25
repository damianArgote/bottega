import { z } from 'zod';
import type { Lead } from '../generated/prisma/client.js';

/** Captured lead data by lead field key (AgentProfile.leadFields). */
export type LeadValues = Record<string, string>;

const leadValuesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  z.string().max(500),
);

/**
 * Fixed Lead columns from before Lead.data, by the lead field key that
 * replaces them. They are still written (so a rollback and the admin API keep
 * working) until the contract migration drops them (02b T7).
 */
export const LEGACY_LEAD_COLUMNS = {
  name: 'name',
  business_name: 'businessName',
  industry: 'industry',
  need: 'need',
  contact_notes: 'contactNotes',
} as const satisfies Record<string, keyof Lead>;

type LegacyColumn =
  (typeof LEGACY_LEAD_COLUMNS)[keyof typeof LEGACY_LEAD_COLUMNS];

/** Trimmed non-empty values only. Throws a ZodError on invalid keys or lengths. */
export function cleanLeadValues(values: Record<string, string>): LeadValues {
  const parsed = leadValuesSchema.parse(values);
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) => {
      const trimmed = value.trim();
      return trimmed ? [[key, trimmed]] : [];
    }),
  );
}

/**
 * Everything known about the lead: the fixed columns (leads written before
 * Lead.data, or by the previous release during a deploy) under Lead.data,
 * which wins. Non-text data is ignored.
 */
export function leadValuesOf(
  lead: (Pick<Lead, LegacyColumn> & { data: unknown }) | null,
): LeadValues {
  if (!lead) {
    return {};
  }
  const values: LeadValues = {};
  for (const [key, column] of Object.entries(LEGACY_LEAD_COLUMNS)) {
    const value = lead[column];
    if (value) {
      values[key] = value;
    }
  }
  const data = lead.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value) {
        values[key] = value;
      }
    }
  }
  return values;
}

/** The fixed columns to write for `values` (old keys only). */
export function legacyColumnsFor(
  values: LeadValues,
): Partial<Record<LegacyColumn, string>> {
  const columns: Partial<Record<LegacyColumn, string>> = {};
  for (const [key, column] of Object.entries(LEGACY_LEAD_COLUMNS)) {
    const value = values[key];
    if (value) {
      columns[column] = value;
    }
  }
  return columns;
}
