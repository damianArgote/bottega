import type { AiInputItem, AiRequest, AiResponse } from '../ai/ai.provider.js';
import { AI_MAX_MODEL_ROUNDS } from '../ai/ai-limits.js';
import { demoRequestSummary, LEAD_SAVED_ACK } from './ai-replies.js';
import { planToolCall } from './tools/registry.js';
import type { ReplyButton } from '../whatsapp/whatsapp.client.js';
import type { PlannedEffect, ToolContext } from './tools/tool.js';

/** WhatsApp allows 4096 characters; keep model text well below it. */
const MAX_REPLY_CHARS = 3000;

/** One tool call the model made, and whether it was accepted. */
export interface ToolCallTrace {
  name: string;
  /** Raw JSON text from the model (untrusted). */
  arguments: string;
  accepted: boolean;
  /** Static rejection label (see planToolCall), when not accepted. */
  reason?: string;
}

export type AgentTurnOutcome =
  /** The model answered with text (possibly after tool calls). */
  | {
      kind: 'text';
      text: string;
      effects: PlannedEffect[];
      calls: ToolCallTrace[];
    }
  /** A handoff was planned: the fixed handoff reply replaces model text. */
  | { kind: 'handoff'; effects: PlannedEffect[]; calls: ToolCallTrace[] }
  /** A model call gave no response (the caller already handled why). */
  | { kind: 'no_response'; calls: ToolCallTrace[] }
  /** Still calling tools after {@link AI_MAX_MODEL_ROUNDS} calls. */
  | { kind: 'rounds_exceeded'; calls: ToolCallTrace[] };

/**
 * One inbound turn against the model: up to {@link AI_MAX_MODEL_ROUNDS}
 * calls, with tool calls validated and planned in memory and their results
 * fed back. Nothing is written or sent here: the bot applies the effects in
 * its job transaction, and the admin preview only reports them. `call`
 * returns null when the turn must stop (e.g. a failed call with a fallback).
 */
export async function runAgentTurn(
  setup: {
    request: Omit<AiRequest, 'input'>;
    input: readonly AiInputItem[];
    tools: Omit<ToolContext, 'planned'>;
  },
  call: (request: AiRequest) => Promise<AiResponse | null>,
  /** Called for each rejected tool call as soon as it is planned. */
  onRejected?: (trace: ToolCallTrace) => void,
): Promise<AgentTurnOutcome> {
  const items = [...setup.input];
  const effects: PlannedEffect[] = [];
  const calls: ToolCallTrace[] = [];

  for (let round = 1; round <= AI_MAX_MODEL_ROUNDS; round += 1) {
    const response = await call({ ...setup.request, input: [...items] });
    if (!response) {
      return { kind: 'no_response', calls };
    }
    if (response.toolCalls.length === 0) {
      return { kind: 'text', text: response.outputText, effects, calls };
    }
    for (const toolCall of response.toolCalls) {
      const result = planToolCall(toolCall, {
        ...setup.tools,
        planned: effects,
      });
      items.push(
        { kind: 'tool_call', ...toolCall },
        { kind: 'tool_result', callId: toolCall.callId, output: result.output },
      );
      const trace: ToolCallTrace = {
        name: toolCall.name,
        arguments: toolCall.arguments,
        accepted: result.ok,
        ...(result.ok ? {} : { reason: result.reason }),
      };
      calls.push(trace);
      if (result.ok) {
        effects.push(result.effect);
      } else {
        onRejected?.(trace);
      }
    }
    if (effects.some((e) => e.kind === 'request_handoff')) {
      return { kind: 'handoff', effects, calls };
    }
  }
  return { kind: 'rounds_exceeded', calls };
}

/** The buttons offer_options planned for this reply, if any. */
export function offeredButtons(
  effects: readonly PlannedEffect[],
): ReplyButton[] | undefined {
  const offer = effects.find((e) => e.kind === 'reply_buttons');
  return offer?.kind === 'reply_buttons' ? offer.buttons : undefined;
}

/**
 * The message sent for a text outcome: model text (capped) plus
 * backend-built confirmations. Null means "use the fallback reply".
 */
export function finalReply(
  text: string,
  effects: readonly PlannedEffect[],
  names: { demoBusinessName: string; botName: string },
): string | null {
  const parts: string[] = [];
  const chars = Array.from(text.trim());
  if (chars.length > 0) {
    parts.push(
      chars.length > MAX_REPLY_CHARS
        ? `${chars.slice(0, MAX_REPLY_CHARS).join('')}…`
        : chars.join(''),
    );
  }
  for (const effect of effects) {
    if (effect.kind === 'register_demo_request') {
      parts.push(
        demoRequestSummary(
          effect.request,
          names.demoBusinessName,
          names.botName,
        ),
      );
    }
  }
  if (parts.length === 0) {
    if (!effects.some((e) => e.kind === 'save_lead')) {
      return null;
    }
    parts.push(LEAD_SAVED_ACK);
  }
  return parts.join('\n\n');
}
