import type { AiToolCall, AiToolDefinition } from '../../ai/ai.provider.js';
import type { ConversationMode } from '../../generated/prisma/client.js';
import { MODE_PROFILES, type ToolName } from '../mode-profiles.js';
import { registerInsuranceRequestTool } from './register-insurance-request.tool.js';
import { quoteInsuranceTool } from './quote-insurance.tool.js';
import { requestHandoffTool } from './request-handoff.tool.js';
import type { LeadField } from '../../agents/agent-profile.schema.js';
import type { DemoContent } from '../../content/content.schema.js';
import { offerOptionsTool } from './offer-options.tool.js';
import { saveLeadToolFor } from './save-lead.tool.js';
import { searchCatalogTool } from './search-catalog.tool.js';
import type {
  CatalogReader,
  PlannedEffect,
  ReadToolHandler,
  ToolContext,
  ToolHandler,
} from './tool.js';

const STATIC_HANDLERS = {
  register_demo_request: registerInsuranceRequestTool,
  quote_insurance: quoteInsuranceTool,
  request_handoff: requestHandoffTool,
  offer_options: offerOptionsTool,
  search_catalog: searchCatalogTool,
} satisfies Partial<Record<ToolName, ToolHandler | ReadToolHandler>>;

type AnyHandler = ToolHandler | ReadToolHandler;

const isReadTool = (tool: AnyHandler): tool is ReadToolHandler =>
  'read' in tool;

const TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  'save_lead',
  'register_demo_request',
  'quote_insurance',
  'request_handoff',
  'offer_options',
  'search_catalog',
]);

/** True for the name of a tool the bot has (any mode or business). */
export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name);
}

/** What the business's agent profile changes in the offered tools. */
export interface ToolOptions {
  demoEnabled: boolean;
  leadFields: readonly LeadField[];
  /** The fictitious business of the active demo (DEMO mode only). */
  demo?: DemoContent;
  /** Set only when the business has an available catalog item. */
  catalog?: CatalogReader;
}

/** The handler of `name` for this business (save_lead is generated). */
export function toolHandlerFor(
  name: ToolName,
  { leadFields }: ToolOptions,
): AnyHandler {
  return name === 'save_lead'
    ? saveLeadToolFor(leadFields)
    : STATIC_HANDLERS[name];
}

/** Tools only the insurance demo has (the quote and its close). */
const INSURANCE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'register_demo_request',
  'quote_insurance',
]);

/** Tools allowed in `mode` for this business (and active demo). */
function offeredTools(
  mode: ConversationMode,
  { demoEnabled, leadFields, demo, catalog }: ToolOptions,
): readonly ToolName[] {
  return MODE_PROFILES[mode].allowedTools.filter(
    (name) =>
      (demoEnabled || name !== 'register_demo_request') &&
      (catalog !== undefined || name !== 'search_catalog') &&
      (leadFields.length > 0 || name !== 'save_lead') &&
      (demo?.scenario === 'insurance' || !INSURANCE_TOOLS.has(name)),
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
 * model; `reason` is a static label for logs (never argument values). A read
 * tool (search_catalog) plans no effect.
 */
export type ToolCallResult =
  | { ok: true; effect: PlannedEffect | null; output: string }
  | { ok: false; reason: string; output: string };

type Rejected = Extract<ToolCallResult, { ok: false }>;

const reject = (reason: string, message: string): Rejected => ({
  ok: false,
  reason,
  output: JSON.stringify({
    ok: false,
    error: `${message} La acción NO se realizó.`,
  }),
});

/**
 * Unknown tools, tools not offered in the active mode (or by the business's
 * profile or catalog), invalid JSON and arguments failing the schema are
 * rejected: nothing runs and the model is told so.
 */
function validateToolCall(
  call: AiToolCall,
  ctx: ToolContext,
): { ok: true; tool: AnyHandler; args: unknown } | Rejected {
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
  return { ok: true, tool, args: parsed.data };
}

/**
 * Validates a tool call from the model and plans its effect (in memory,
 * nothing is written). Read tools only run through {@link runToolCall}.
 */
export function planToolCall(
  call: AiToolCall,
  ctx: ToolContext,
): ToolCallResult {
  const valid = validateToolCall(call, ctx);
  if (!valid.ok) {
    return valid;
  }
  if (isReadTool(valid.tool)) {
    return reject('read_tool', 'Herramienta no disponible en este modo.');
  }
  const plan = valid.tool.plan(valid.args, ctx);
  if (!plan.ok) {
    return reject('plan_rejected', plan.error);
  }
  return {
    ok: true,
    effect: plan.effect,
    output: JSON.stringify({ ok: true, ...plan.output }),
  };
}

/**
 * Like {@link planToolCall}, and also runs read tools (they query the
 * database and plan no effect). A database error propagates.
 */
export async function runToolCall(
  call: AiToolCall,
  ctx: ToolContext,
): Promise<ToolCallResult> {
  const valid = validateToolCall(call, ctx);
  if (!valid.ok || !isReadTool(valid.tool)) {
    return planToolCall(call, ctx);
  }
  const output = await valid.tool.read(valid.args, ctx);
  return {
    ok: true,
    effect: null,
    output: JSON.stringify({ ok: true, ...output }),
  };
}
