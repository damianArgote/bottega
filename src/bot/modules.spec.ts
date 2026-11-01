import { DEFAULT_LEAD_FIELDS } from '../agents/default-agent-profile.seed.js';
import { activeModules, MODULE_TOOLS, moduleAllows } from './modules.js';
import { toolDefinitionsFor } from './tools/registry.js';
import type { CatalogReader } from './tools/tool.js';

const catalog: CatalogReader = { search: () => Promise.resolve([]) };

describe('business modules', () => {
  it('lists the modules that are on, in a fixed order', () => {
    expect(activeModules({})).toEqual([]);
    expect(activeModules({ catalog })).toEqual(['catalog']);
  });

  it("offers a module's tools only while the module is on", () => {
    const names = (modules: { catalog?: CatalogReader }) =>
      toolDefinitionsFor('COMMERCIAL', {
        demoEnabled: false,
        leadFields: DEFAULT_LEAD_FIELDS,
        modules,
      }).map((t) => t.name);

    for (const tool of MODULE_TOOLS.catalog) {
      expect(moduleAllows(tool, {})).toBe(false);
      expect(moduleAllows(tool, { catalog })).toBe(true);
      expect(names({})).not.toContain(tool);
      expect(names({ catalog })).toContain(tool);
    }
    // Tools outside every module do not depend on them.
    expect(moduleAllows('request_handoff', {})).toBe(true);
  });
});
