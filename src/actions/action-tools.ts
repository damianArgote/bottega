import type { z } from 'zod';
import type { ActionOutcome } from './action-caller.service.js';
import {
  actionArgumentsSchema,
  actionJsonSchema,
  type ActionParameters,
} from './action-parameters.js';

/** One business action as a tool of the agent. */
export interface ActionTool {
  name: string;
  /** What the model reads: framed as the business's information. */
  description: string;
  jsonSchema: Record<string, unknown>;
  /** Validates the model's arguments (nulls of optional ones dropped). */
  args: z.ZodType<Record<string, unknown>>;
  kind: 'query' | 'effect';
}

/**
 * The `actions` module of a business: its active actions as tools, and how
 * to call one in the current turn (the idempotency key is built there).
 */
export interface ActionsModule {
  tools: readonly ActionTool[];
  run(name: string, args: Record<string, unknown>): Promise<ActionOutcome>;
}

/** What the tools are built from (a stored AgentAction, or a scenario's). */
export interface ActionDefinition {
  name: string;
  description: string;
  parameters: ActionParameters;
  kind: 'query' | 'effect';
}

const ACTION_DESCRIPTION_PREFIX: Record<ActionTool['kind'], string> = {
  query: 'Consulta en el sistema del negocio.',
  effect: 'Hace un cambio en el sistema del negocio.',
};

export function actionTools(
  definitions: readonly ActionDefinition[],
): ActionTool[] {
  return definitions.map((d) => ({
    name: d.name,
    description: `${ACTION_DESCRIPTION_PREFIX[d.kind]} Descripción del negocio: ${d.description}`,
    jsonSchema: actionJsonSchema(d.parameters),
    args: actionArgumentsSchema(d.parameters),
    kind: d.kind,
  }));
}
