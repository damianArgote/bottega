import { z } from 'zod';
import type { DemoContent } from '../../content/content.schema.js';
import type { DemoScenario } from '../../demos/demo-scenarios.js';
import type { DemoRequestInput } from '../../demos/demos.service.js';
import type { Quote } from '../../demos/insurance-quote.js';
import type { ConversationMode } from '../../generated/prisma/client.js';
import type { LeadField } from '../../agents/agent-profile.schema.js';
import type { LeadValues } from '../../leads/lead-values.js';
import type { ReplyButton } from '../../whatsapp/whatsapp.client.js';
import type { ToolName } from '../mode-profiles.js';

/**
 * A validated tool call turned into a change to apply later, inside the
 * job's phase-1 transaction (never during the model loop).
 */
export type PlannedEffect =
  | { kind: 'save_lead'; values: LeadValues }
  | {
      kind: 'register_demo_request';
      scenario: DemoScenario;
      request: DemoRequestInput;
      /** Also hands the conversation off (the insurance demo's close). */
      handoffReason?: string;
    }
  /** Simulated prices (quote_insurance); nothing to apply. */
  | { kind: 'insurance_quote'; quote: Quote }
  | { kind: 'request_handoff'; reason: string | null }
  /** Reply buttons under the reply (offer_options); nothing to apply. */
  | { kind: 'reply_buttons'; buttons: ReplyButton[] }
  /** Not a tool: the generator added the out-of-hours notice on `day`. */
  | { kind: 'out_of_hours_notice'; day: string }
  /** Not a tool: the business reached its monthly AI cap (hands off). */
  | { kind: 'ai_monthly_cap_handoff' };

/** What a tool may read while planning. */
export interface ToolContext {
  mode: ConversationMode;
  /** The fictitious business of the active demo (DEMO mode only). */
  demo?: DemoContent;
  /** Effects already planned for this message (to reject duplicates). */
  planned: readonly PlannedEffect[];
  /** The business's profile offers the demo (register_demo_request). */
  demoEnabled: boolean;
  /** The business's lead fields: save_lead is generated from them. */
  leadFields: readonly LeadField[];
}

/**
 * Result of planning: `output` is what the model reads back as the tool
 * result, so it must say clearly whether the action will happen.
 */
export type ToolPlan =
  | { ok: true; effect: PlannedEffect; output: Record<string, unknown> }
  | { ok: false; error: string };

export interface ToolHandler<Args = unknown> {
  name: ToolName;
  description: string;
  allowedModes: readonly ConversationMode[];
  /** Strict JSON Schema sent to the model (mirrors `schema`). */
  jsonSchema: Record<string, unknown>;
  /** Validates the model's arguments; `.strict()` rejects unknown keys. */
  schema: z.ZodType<Args>;
  plan(args: Args, ctx: ToolContext): ToolPlan;
}

// Control characters (C0, DEL, C1; newlines and tabs too: one-line values).
const CONTROL_CHARS = /\p{Cc}/gu;
const URL_PATTERN = /(https?:\/\/|www\.)/i;

/** Single-line plain text: control characters become spaces, then trimmed. */
export function cleanText(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Nullable plain-text argument: cleaned, at most `max` characters, links
 * rejected. Blank values become null.
 */
export function textArg(max: number) {
  return z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : cleanText(value) || null))
    .refine((value) => value === null || value.length <= max, {
      message: `must be at most ${max} characters`,
    })
    .refine((value) => value === null || !URL_PATTERN.test(value), {
      message: 'links are not accepted',
    });
}

/** JSON Schema for a nullable string argument (strict mode friendly). */
export function nullableString(description: string): Record<string, unknown> {
  return { type: ['string', 'null'], description };
}

/** Strict-mode object schema: every property required, no extra keys. */
export function strictObject(
  properties: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
