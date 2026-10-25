import type { AiToolCall, AiToolDefinition } from '../../ai/ai.provider.js';
import type { ConversationMode } from '../../generated/prisma/client.js';
import { MODE_PROFILES, type ToolName } from '../mode-profiles.js';
import { registerDemoRequestTool } from './register-demo-request.tool.js';
import { requestHandoffTool } from './request-handoff.tool.js';
import type { LeadField } from '../../agents/agent-profile.schema.js';
import { offerOptionsTool } from './offer-options.tool.js';
import { saveLeadToolFor } from './save-lead.tool.js';
import type { PlannedEffect, ToolContext, ToolHandler } from './tool.js';

const STATIC_HANDLERS = {
  register_demo_request: registerDemoRequestTool,
  request_handoff: requestHandoffTool,
  offer_options: offerOptionsTool,
} satisfies Partial<Record<ToolName, ToolHandler>>;

const TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  'save_lead',
  'register_demo_request',
  'request_handoff',
  'offer_options',
]);

/** True for the name of a tool the bot has (any mode or business). */
export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name);
}

/** What the business's agent profile changes in the offered tools. */
export interface ToolOptions {
  demoEnabled: boolean;
  leadFields: readonly LeadField[];
}

/** The handler of `name` for this business (save_lead is generated). */
export function toolHandlerFor(
  name: ToolName,
  { leadFields }: ToolOptions,
): ToolHandler {
  return name === 'save_lead'
    ? saveLeadToolFor(leadFields)
    : STATIC_HANDLERS[name];
}

/** Tools allowed in `mode` for this business. */
function offeredTools(
  mode: ConversationMode,
  { demoEnabled, leadFields }: ToolOptions,
): readonly ToolName[] {
  return MODE_PROFILES[mode].allowedTools.filter(
    (name) =>
      (demoEnabled || name !== 'register_demo_request') &&
      (leadFields.length > 0 || name !== 'save_lead'),
  );
}

/** Tool definitions offered to the model in `mode`. */
export function toolDefinitionsFor(
  mode: ConversationMode,
  options: ToolOptions,
): AiToolDefinition[] {
  return offeredTools(mode, options).map((name) => {
    const tool = toolHandlerFor(name, options);
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
  if (!isToolName(call.name)) {
    return reject('unknown_tool', 'Herramienta desconocida.');
  }
  const name = call.name;
  const tool = toolHandlerFor(name, ctx);
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
