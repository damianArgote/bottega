import type { ActionsModule } from '../actions/action-tools.js';
import type { ToolName } from './mode-profiles.js';
import type { CatalogReader } from './tools/tool.js';

/** The optional capabilities a business can have (prompt 07). */
export type ModuleName = 'catalog' | 'actions' | 'payments' | 'scheduling';

/**
 * The modules a business has on, with what their tools need. A module that
 * is absent is off: the model is not offered any of its tools, and the
 * business works as if the module did not exist. Built by
 * BusinessModulesService (the only place that decides it).
 */
export interface BusinessModules {
  /** Set only when the business has an available catalog item. */
  catalog?: CatalogReader;
  /** Set only when the business has an active action (one tool each). */
  actions?: ActionsModule;
}

/** Built-in tools that belong to a module (offered only when it is on). */
export const MODULE_TOOLS: Readonly<Record<ModuleName, readonly ToolName[]>> =
  {
    catalog: ['search_catalog'],
    actions: [],
    payments: [],
    scheduling: [],
  };

const TOOL_MODULE: ReadonlyMap<ToolName, ModuleName> = new Map(
  (Object.keys(MODULE_TOOLS) as ModuleName[]).flatMap((module) =>
    MODULE_TOOLS[module].map((tool) => [tool, module] as const),
  ),
);

/** Whether `modules` has `module` on. */
export function hasModule(
  modules: BusinessModules,
  module: ModuleName,
): boolean {
  return (modules as Partial<Record<ModuleName, unknown>>)[module] !== undefined;
}

/** False for a module tool whose module is off; true for any other tool. */
export function moduleAllows(
  tool: ToolName,
  modules: BusinessModules,
): boolean {
  const module = TOOL_MODULE.get(tool);
  return module === undefined || hasModule(modules, module);
}

/** The modules that are on, in a fixed order (for logs and the API). */
export function activeModules(modules: BusinessModules): ModuleName[] {
  return (Object.keys(MODULE_TOOLS) as ModuleName[]).filter((m) =>
    hasModule(modules, m),
  );
}
