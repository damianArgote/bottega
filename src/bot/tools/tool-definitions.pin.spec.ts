import { loadContent } from '../../content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../../content/content.service.js';
import { DEFAULT_LEAD_FIELDS } from '../../agents/default-agent-profile.seed.js';
import { toolDefinitionsFor } from './registry.js';
import type { CatalogReader } from './tool.js';

const { insurance } = loadContent(DEFAULT_CONTENT_DIR);
const catalog: CatalogReader = { search: () => Promise.resolve([]) };

/**
 * The tools existing businesses get, pinned before the modules refactor
 * (prompt 07b): BotSuite46 (demo, four lead fields, no catalog) and a
 * business with a catalog and no demo. Any change here changes what the
 * model is offered.
 */
describe('tool definitions of existing businesses', () => {
  it('BotSuite46, commercial and insurance demo', async () => {
    const botsuite = { demoEnabled: true, leadFields: DEFAULT_LEAD_FIELDS };
    await expect({
      commercial: toolDefinitionsFor('COMMERCIAL', botsuite),
      demo: toolDefinitionsFor('DEMO', { ...botsuite, demo: insurance }),
    }).toMatchFileSnapshot('./__snapshots__/botsuite46.tools.json');
  });

  it('a business with a catalog and no demo', async () => {
    await expect(
      toolDefinitionsFor('COMMERCIAL', {
        demoEnabled: false,
        leadFields: DEFAULT_LEAD_FIELDS,
        modules: { catalog },
      }),
    ).toMatchFileSnapshot('./__snapshots__/catalog-business.tools.json');
  });
});
