import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CommercialTurnResult } from '../bot/commercial-turn.js';

/**
 * `<project root>/scenarios`. This file lives at `src/scenarios/` when run
 * from source and at `dist/scenarios/` when built, two levels below the root.
 */
export const SCENARIOS_DIR = fileURLToPath(
  new URL('../../scenarios/', import.meta.url),
);

const TOOL_NAMES = [
  'save_lead',
  'register_demo_request',
  'request_handoff',
  'offer_options',
] as const;
const text = z.string().trim().min(1);

const turnSchema = z
  .object({
    /** What the user writes in this turn. */
    user: text,
    /** Each entry must appear in the reply; an array means "any of these". */
    mustInclude: z.array(z.union([text, z.array(text).min(1)])).optional(),
    mustNotInclude: z.array(text).optional(),
    /** Each tool must be called and accepted in this turn. */
    mustCallTool: z.array(z.enum(TOOL_NAMES)).optional(),
    /** Each tool must not be called at all (accepted or not). */
    mustNotCallTool: z.array(z.enum(TOOL_NAMES)).optional(),
    /** No offer_options button in this turn may contain these texts. */
    mustNotOffer: z.array(text).optional(),
    /** Each text must be in an accepted offer_options button of this turn. */
    mustOffer: z.array(text).optional(),
  })
  .strict();

export type ScenarioTurn = z.infer<typeof turnSchema>;

const scenarioSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: text.optional(),
    initial: z
      .object({
        /** Lead values already captured, by lead field key. */
        known: z.record(z.string(), text).optional(),
        /** Earlier messages of the conversation, oldest first. */
        history: z
          .array(
            z
              .object({ role: z.enum(['user', 'assistant']), content: text })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    turns: z.array(turnSchema).min(1),
  })
  .strict();

export type Scenario = z.infer<typeof scenarioSchema>;

const scenarioFileSchema = z
  .object({
    /** Business slug: the agent profile the scenarios run against. */
    business: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    scenarios: z.array(scenarioSchema).min(1),
  })
  .strict();

export type ScenarioFile = z.infer<typeof scenarioFileSchema>;

/** Throws a ZodError when the file does not follow the format. */
export function parseScenarioFile(value: unknown): ScenarioFile {
  return scenarioFileSchema.parse(value);
}

export function loadScenarioFile(path: string): ScenarioFile {
  return parseScenarioFile(JSON.parse(readFileSync(path, 'utf8')));
}

/** Lowercase without accents, so assertions survive the model's casing. */
function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Failed assertions of one turn; empty when it passes. */
export function checkTurn(
  turn: ScenarioTurn,
  result: Pick<CommercialTurnResult, 'reply' | 'toolCalls'>,
): string[] {
  const reply = normalize(result.reply);
  const failures: string[] = [];
  for (const entry of turn.mustInclude ?? []) {
    const options = Array.isArray(entry) ? entry : [entry];
    if (!options.some((o) => reply.includes(normalize(o)))) {
      failures.push(
        Array.isArray(entry)
          ? `mustInclude one of ${entry.map((o) => `"${o}"`).join(' | ')}`
          : `mustInclude "${entry}"`,
      );
    }
  }
  for (const entry of turn.mustNotInclude ?? []) {
    if (reply.includes(normalize(entry))) {
      failures.push(`mustNotInclude "${entry}"`);
    }
  }
  for (const tool of turn.mustCallTool ?? []) {
    if (!result.toolCalls.some((c) => c.name === tool && c.accepted)) {
      failures.push(`mustCallTool ${tool} (no accepted call)`);
    }
  }
  const offered = result.toolCalls
    .filter((c) => c.name === 'offer_options' && c.accepted)
    .flatMap((c) => {
      const options = (c.arguments as { options?: unknown } | null)?.options;
      return Array.isArray(options) ? options.map(String) : [];
    })
    .map(normalize);
  for (const entry of turn.mustOffer ?? []) {
    if (!offered.some((o) => o.includes(normalize(entry)))) {
      failures.push(`mustOffer "${entry}"`);
    }
  }
  for (const entry of turn.mustNotOffer ?? []) {
    if (offered.some((o) => o.includes(normalize(entry)))) {
      failures.push(`mustNotOffer "${entry}"`);
    }
  }
  for (const tool of turn.mustNotCallTool ?? []) {
    if (result.toolCalls.some((c) => c.name === tool)) {
      failures.push(`mustNotCallTool ${tool}`);
    }
  }
  return failures;
}
