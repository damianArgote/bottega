// Runs the agent scenarios (scenarios/<slug>.json) against the REAL model.
// Costs money: never part of `npm test` or CI.
// Usage: npm run test:scenarios [-- <scenario name>...]
import 'dotenv/config';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAgentProfile } from '../agents/default-agent-profile.seed.js';
import type { AgentProfile } from '../agents/agent-profile.js';
import { OpenAiProvider } from '../ai/openai.provider.js';
import { runCommercialTurn, type TurnMessage } from '../bot/commercial-turn.js';
import { EnvValidationError, parseEnv } from '../config/env.schema.js';
import { loadContent } from '../content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../content/content.service.js';
import type { LeadValues } from '../leads/lead-values.js';
import {
  DEFAULT_BOT_NAME,
  DEFAULT_BUSINESS_SLUG,
} from '../lines/default-line.seed.js';
import {
  checkTurn,
  loadScenarioFile,
  SCENARIOS_DIR,
} from '../scenarios/scenario.js';

const content = loadContent(DEFAULT_CONTENT_DIR);

/** Agent profiles scenarios can run against, by business slug. */
const PROFILES: Record<string, () => AgentProfile> = {
  [DEFAULT_BUSINESS_SLUG]: () => ({
    ...defaultAgentProfile(DEFAULT_BOT_NAME, content.commercialInfo),
    version: null,
  }),
};

async function main(): Promise<void> {
  // Same validation as the app in AI mode: OPENAI_API_KEY and OPENAI_MODEL
  // are required. Messages list variable names only.
  const env = parseEnv({ ...process.env, BOT_REPLY_MODE: 'ai' });
  const provider = new OpenAiProvider({
    apiKey: env.OPENAI_API_KEY ?? '',
    timeoutMs: env.OPENAI_TIMEOUT_MS,
  });
  const only = new Set(process.argv.slice(2));
  let passed = 0;
  let failed = 0;
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };

  for (const fileName of readdirSync(SCENARIOS_DIR).filter((f) =>
    f.endsWith('.json'),
  )) {
    const file = loadScenarioFile(join(SCENARIOS_DIR, fileName));
    const profile = PROFILES[file.business]?.();
    if (!profile) {
      throw new Error(`${fileName}: no agent profile for "${file.business}"`);
    }
    for (const scenario of file.scenarios) {
      if (only.size > 0 && !only.has(scenario.name)) {
        continue;
      }
      const messages: TurnMessage[] = [...(scenario.initial?.history ?? [])];
      let known: LeadValues = { ...scenario.initial?.known };
      const failures: string[] = [];
      for (const [index, turn] of scenario.turns.entries()) {
        messages.push({ role: 'user', content: turn.user });
        const result = await runCommercialTurn({
          provider,
          profile,
          defaultModel: env.OPENAI_MODEL ?? '',
          maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
          barbershop: content.barbershop,
          messages,
          known,
        });
        totals.calls += result.usage.calls;
        totals.inputTokens += result.usage.inputTokens;
        totals.outputTokens += result.usage.outputTokens;
        console.log(
          `\n[${file.business}/${scenario.name} #${index + 1}] user: ${turn.user}`,
        );
        console.log(`  bot: ${result.reply.replace(/\n/g, '\n       ')}`);
        for (const call of result.toolCalls) {
          console.log(
            `  tool: ${call.name} ${call.accepted ? 'accepted' : `rejected (${call.reason})`} ${JSON.stringify(call.arguments)}`,
          );
        }
        failures.push(
          ...checkTurn(turn, result).map((f) => `turn ${index + 1}: ${f}`),
        );
        messages.push({ role: 'assistant', content: result.reply });
        for (const effect of result.effects) {
          if (effect.kind === 'save_lead') {
            known = { ...known, ...effect.values };
          }
        }
      }
      if (failures.length === 0) {
        passed += 1;
        console.log(`  PASS ${scenario.name}`);
      } else {
        failed += 1;
        console.log(
          `  FAIL ${scenario.name}\n    - ${failures.join('\n    - ')}`,
        );
      }
    }
  }
  console.log(
    `\nScenarios: ${passed} passed, ${failed} failed. Model calls: ${totals.calls}, tokens in/out: ${totals.inputTokens}/${totals.outputTokens}.`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof EnvValidationError
      ? `test:scenarios failed: ${error.message}`
      : `test:scenarios failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'UnknownError'}`,
  );
  process.exitCode = 1;
});
