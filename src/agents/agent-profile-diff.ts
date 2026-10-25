import {
  type AgentProfileInput,
  agentProfileSchema,
} from './agent-profile.schema.js';

/** One field of the profile that differs between two versions. */
export interface FieldChange {
  field: keyof AgentProfileInput;
  /** null when the field had no value (or there is no previous version). */
  before: string | null;
  after: string | null;
}

const FIELDS = Object.keys(
  agentProfileSchema.shape,
) as (keyof AgentProfileInput)[];

/** Texts as they are; lists and objects as indented JSON, so lines compare. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * The fields that changed from `before` (null: the first version) to
 * `after`, in the schema's order. Snapshots are read as stored, so an old
 * one with a missing field compares as no value.
 */
export function diffProfiles(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>>,
): FieldChange[] {
  return FIELDS.flatMap((field) => {
    const old = asText(before?.[field]);
    const now = asText(after[field]);
    return old === now ? [] : [{ field, before: old, after: now }];
  });
}
