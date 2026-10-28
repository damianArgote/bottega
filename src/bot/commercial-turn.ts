import type { AiProvider, AiRequest, AiResponse } from '../ai/ai.provider.js';
import type { AgentProfile } from '../agents/agent-profile.js';
import { ConversationMode } from '../generated/prisma/client.js';
import type { LeadValues } from '../leads/lead-values.js';
import { AI_FALLBACK_REPLY } from './ai-replies.js';
import { finalReply, offeredButtons, runAgentTurn } from './agent-turn.js';
import { buildCommercialInstructions } from './prompts.js';
import { renderReply } from './replies.js';
import { toolDefinitionsFor } from './tools/registry.js';
import type { PlannedEffect } from './tools/tool.js';

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnToolCall {
  name: string;
  /** The model's arguments, parsed when they are valid JSON. */
  arguments: unknown;
  accepted: boolean;
  reason?: string;
}

export interface CommercialTurnResult {
  /** What the bot would send. */
  reply: string;
  toolCalls: TurnToolCall[];
  /** Accepted effects, planned but not applied. */
  effects: PlannedEffect[];
  /** Reply buttons under the reply (offer_options). */
  buttons: { id: string; title: string }[];
  model: string;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * One commercial turn of a business's agent from a list of messages, with
 * nothing stored or sent: the admin preview and the scenario runner use it.
 * Same prompt, tools and model selection as the live bot. Model failures
 * propagate (AiProviderError).
 */
export async function runCommercialTurn(input: {
  provider: AiProvider;
  profile: AgentProfile;
  /** OPENAI_MODEL, used when the profile has no model. */
  defaultModel: string;
  maxOutputTokens: number;
  messages: readonly TurnMessage[];
  known?: LeadValues;
  /** Called after every model call (for logging). */
  onCall?: (response: AiResponse, latencyMs: number) => void;
}): Promise<CommercialTurnResult> {
  const { profile } = input;
  const model = profile.model ?? input.defaultModel;
  const mode = ConversationMode.COMMERCIAL;
  const toolOptions = {
    demoEnabled: profile.demoEnabled,
    leadFields: profile.leadFields,
  };
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  const call = async (request: AiRequest): Promise<AiResponse> => {
    const started = Date.now();
    const response = await input.provider.respond(request);
    usage.calls += 1;
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    input.onCall?.(response, Date.now() - started);
    return response;
  };

  const outcome = await runAgentTurn(
    {
      request: {
        model,
        instructions: buildCommercialInstructions(profile, input.known ?? {}),
        tools: toolDefinitionsFor(mode, toolOptions),
        maxOutputTokens: input.maxOutputTokens,
      },
      input: input.messages.map((m) => ({ kind: 'message', ...m })),
      tools: { mode, ...toolOptions },
    },
    call,
  );

  // Commercial mode: no demo business to name.
  const names = { demoBusinessName: '', botName: profile.botName };
  const reply =
    outcome.kind === 'handoff'
      ? renderReply('HUMAN_REQUESTED', names)
      : outcome.kind === 'text'
        ? (finalReply(outcome.text, outcome.effects, names) ??
          AI_FALLBACK_REPLY)
        : AI_FALLBACK_REPLY;
  return {
    reply,
    toolCalls: outcome.calls.map((c) => ({
      name: c.name,
      arguments: parseArguments(c.arguments),
      accepted: c.accepted,
      ...(c.reason ? { reason: c.reason } : {}),
    })),
    effects:
      outcome.kind === 'text' || outcome.kind === 'handoff'
        ? outcome.effects
        : [],
    buttons:
      outcome.kind === 'text' ? (offeredButtons(outcome.effects) ?? []) : [],
    model,
    usage,
  };
}
