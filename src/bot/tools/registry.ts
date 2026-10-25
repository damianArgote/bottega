import type { AiToolCall, AiToolDefinition } from '../../ai/ai.provider.js';
import type { ConversationMode } from '../../generated/prisma/client.js';
import { MODE_PROFILES, type ToolName } from '../mode-profiles.js';
import { registerDemoRequestTool } from './register-demo-request.tool.js';
import { requestHandoffTool } from './request-handoff.tool.js';
import { saveLeadTool } from './save-lead.tool.js';
import type { PlannedEffect, ToolContext, ToolHandler } from './tool.js';

export const TOOL_HANDLERS: Readonly<Record<ToolName, ToolHandler>> = {
  save_lead: saveLeadTool,
  register_demo_request: registerDemoRequestTool,
  request_handoff: requestHandoffTool,
};

/** What the business's agent profile changes in the offered tools. */
export interface ToolOptions {
  demoEnabled: boolean;
}

/** Tools allowed in `mode` for this business. */
function offeredTools(
  mode: ConversationMode,
  { demoEnabled }: ToolOptions,
): readonly ToolName[] {
  return MODE_PROFILES[mode].allowedTools.filter(
    (name) => demoEnabled || name !== 'register_demo_request',
  );
}

/** Tool definitions offered to the model in `mode`. */
export function toolDefinitionsFor(
  mode: ConversationMode,
  options: ToolOptions,
): AiToolDefinition[] {
  return offeredTools(mode, options).map((name) => {
    const tool = TOOL_HANDLERS[name];
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    };
  });
}

/**
 * Outcome of one model tool call. `output` is the JSON text returned to the
 * model; `reason` is a static label for logs (never argument values).
 */
export type ToolCallResult =
  | { ok: true; effect: PlannedEffect; output: string }
  | { ok: false; reason: string; output: string };

const reject = (reason: string, message: string): ToolCallResult => ({
  ok: false,
  reason,
  output: JSON.stringify({
    ok: false,
    error: `${message} La acción NO se realizó.`,
  }),
});

/**
 * Validates a tool call from the model and plans its effect. Unknown tools,
 * tools not offered in the active mode (or by the business's profile), invalid JSON and arguments failing
 * the schema are rejected: nothing is planned and the model is told so.
 */
export function planToolCall(
  call: AiToolCall,
  ctx: ToolContext,
): ToolCallResult {
  const name = call.name as ToolName;
  const tool = Object.hasOwn(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : null;
  if (!tool) {
    return reject('unknown_tool', 'Herramienta desconocida.');
  }
  if (
    !tool.allowedModes.includes(ctx.mode) ||
    !offeredTools(ctx.mode, ctx).includes(name)
  ) {
    return reject(
      'tool_not_allowed',
      'Herramienta no disponible en este modo.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    return reject('invalid_json', 'Argumentos inválidos.');
  }
  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.map(String).join('.') || '(root)')
      .join(', ');
    return reject('invalid_arguments', `Argumentos inválidos: ${fields}.`);
  }

  const plan = tool.plan(parsed.data, ctx);
  if (!plan.ok) {
    return reject('plan_rejected', plan.error);
  }
  return {
    ok: true,
    effect: plan.effect,
    output: JSON.stringify({ ok: true, ...plan.output }),
  };
}
