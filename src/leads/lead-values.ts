import { z } from 'zod';

/** Captured lead data by lead field key (AgentProfile.leadFields). */
export type LeadValues = Record<string, string>;

const leadValuesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  z.string().max(500),
);

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

/** Everything known about the lead (Lead.data); non-text data is ignored. */
export function leadValuesOf(lead: { data: unknown } | null): LeadValues {
  const values: LeadValues = {};
  const data = lead?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value) {
        values[key] = value;
      }
    }
  }
  return values;
}
