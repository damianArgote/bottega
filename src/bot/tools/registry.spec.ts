import { offeredButtons } from '../agent-turn.js';
import { loadContent } from '../../content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../../content/content.service.js';
import { MODE_PROFILES, type ToolName } from '../mode-profiles.js';
import { DEFAULT_LEAD_FIELDS } from '../../agents/default-agent-profile.seed.js';
import {
  planToolCall,
  runToolCall,
  toolDefinitionsFor,
  toolHandlerFor,
  type ToolCallResult,
  type ToolOptions,
} from './registry.js';
import type { CatalogReader, PlannedEffect, ToolContext } from './tool.js';

const { aesthetics, insurance } = loadContent(DEFAULT_CONTENT_DIR);

const ctx = (
  mode: ToolContext['mode'],
  planned: PlannedEffect[] = [],
  demoEnabled = true,
): ToolContext => ({
  mode,
  ...(mode === 'DEMO' ? { demo: insurance } : {}),
  planned,
  demoEnabled,
  leadFields: DEFAULT_LEAD_FIELDS,
});

/** A business with a catalog whose searches find nothing. */
const noCatalog: CatalogReader = { search: () => Promise.resolve([]) };

/** BotSuite46's profile: the demo and its four lead fields. */
const options: ToolOptions = {
  demoEnabled: true,
  leadFields: DEFAULT_LEAD_FIELDS,
};

const TOOL_NAMES: ToolName[] = [
  'save_lead',
  'register_demo_request',
  'quote_insurance',
  'request_handoff',
];

const call = (name: string, args: unknown) => ({
  callId: 'call_1',
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

const lead = (overrides: Record<string, unknown> = {}) => ({
  name: null,
  business_name: null,
  industry: null,
  need: null,
  demo_feedback: null,
  ...overrides,
});

/** The insurance demo's close (see insurance-tools.spec.ts). */
const booking = (overrides: Record<string, unknown> = {}) => ({
  customerName: 'Juan',
  model: 'Gol Trend',
  version: 'Trendline',
  year: 2018,
  location: 'Caballito',
  zone: 'CABA',
  gnc: false,
  priority: null,
  plan: 'Terceros Completo',
  contactPreference: null,
  ...overrides,
});

function expectRejected(result: ToolCallResult, reason: string) {
  expect(result).toMatchObject({ ok: false, reason });
  const output = JSON.parse(result.output) as { ok: boolean; error: string };
  expect(output.ok).toBe(false);
  expect(output.error).toContain('NO se realizó');
}

describe('tool registry', () => {
  it('keeps every JSON schema strict and mirrored by its zod schema', () => {
    for (const tool of TOOL_NAMES.map((name) =>
      toolHandlerFor(name, options),
    )) {
      const schema = tool.jsonSchema as {
        properties: Record<string, { type: string[] }>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties));
      // Strict mode: every argument is required, so all are nullable.
      for (const prop of Object.values(schema.properties)) {
        expect(prop.type).toContain('null');
      }
      // All-null arguments parse (every key accepted), extra keys do not.
      const nulls = Object.fromEntries(schema.required.map((k) => [k, null]));
      expect(tool.schema.safeParse(nulls).success).toBe(true);
      expect(tool.schema.safeParse({ ...nulls, extra: 'x' }).success).toBe(
        false,
      );
    }
  });

  it('offers each mode exactly its allowed tools, consistent with allowedModes', () => {
    for (const profile of Object.values(MODE_PROFILES)) {
      const withDemo = { ...options, demo: insurance, catalog: noCatalog };
      const names = toolDefinitionsFor(profile.mode, withDemo).map(
        (t) => t.name,
      );
      expect(names).toEqual(profile.allowedTools);
      for (const name of names) {
        expect(
          toolHandlerFor(name as ToolName, withDemo).allowedModes,
        ).toContain(profile.mode);
      }
    }
  });

  it('offers the quote and its close only in the insurance demo', () => {
    const names = (demo?: ToolOptions['demo']) =>
      toolDefinitionsFor('DEMO', { ...options, ...(demo ? { demo } : {}) }).map(
        (t) => t.name,
      );

    expect(names(insurance)).toContain('quote_insurance');
    expect(names(aesthetics)).not.toContain('quote_insurance');
    expect(names(aesthetics)).not.toContain('register_demo_request');
    expect(names(aesthetics)).toEqual(['request_handoff', 'offer_options']);
    expect(
      planToolCall(
        call('quote_insurance', {
          model: 'Gol Trend',
          year: 2018,
          zone: 'CABA',
          gnc: false,
        }),
        { ...ctx('DEMO'), demo: aesthetics },
      ),
    ).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
  });

  it('rejects unknown tools, invalid JSON and tools outside the mode', () => {
    expectRejected(
      planToolCall(call('run_sql', {}), ctx('COMMERCIAL')),
      'unknown_tool',
    );
    expectRejected(
      planToolCall(call('toString', {}), ctx('COMMERCIAL')),
      'unknown_tool',
    );
    expectRejected(
      planToolCall(call('save_lead', '{not json'), ctx('COMMERCIAL')),
      'invalid_json',
    );
    expectRejected(
      planToolCall(call('save_lead', lead({ name: 'Ana' })), ctx('DEMO')),
      'tool_not_allowed',
    );
    expectRejected(
      planToolCall(call('register_demo_request', booking()), ctx('COMMERCIAL')),
      'tool_not_allowed',
    );
  });

  describe('save_lead', () => {
    it('plans only the non-empty fields, cleaned', () => {
      const result = planToolCall(
        call(
          'save_lead',
          lead({ name: '  Ana\n\u0007 Pérez ', industry: '', need: 'turnos' }),
        ),
        ctx('COMMERCIAL'),
      );
      expect(result).toMatchObject({
        ok: true,
        effect: {
          kind: 'save_lead',
          values: { name: 'Ana Pérez', need: 'turnos' },
        },
      });
    });

    it('rejects extra fields, missing fields, long values, links and empty calls', () => {
      const commercial = ctx('COMMERCIAL');
      expectRejected(
        planToolCall(call('save_lead', lead({ email: 'a@b.c' })), commercial),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(call('save_lead', { name: 'Ana' }), commercial),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(
          call('save_lead', lead({ need: 'x'.repeat(201) })),
          commercial,
        ),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(
          call('save_lead', lead({ need: 'ver https://evil.test' })),
          commercial,
        ),
        'invalid_arguments',
      );
      expectRejected(
        planToolCall(call('save_lead', lead({ name: ' \n ' })), commercial),
        'plan_rejected',
      );
    });
  });

  describe('save_lead without lead fields', () => {
    it('is not offered and is rejected if called anyway', () => {
      const noFields = { ...options, leadFields: [] };

      expect(
        toolDefinitionsFor('COMMERCIAL', noFields).map((t) => t.name),
      ).toEqual(['request_handoff', 'offer_options']);
      expectRejected(
        planToolCall(call('save_lead', { name: 'Ana' }), {
          ...ctx('COMMERCIAL'),
          leadFields: [],
        }),
        'tool_not_allowed',
      );
    });
  });

  describe('register_demo_request', () => {
    it('rejects a second request in the same message', () => {
      expectRejected(
        planToolCall(
          call('register_demo_request', booking()),
          ctx('DEMO', [
            {
              kind: 'register_demo_request',
              scenario: 'insurance',
              request: {},
            },
          ]),
        ),
        'plan_rejected',
      );
    });
  });

  describe('offer_options', () => {
    const offer = (options: unknown) =>
      planToolCall(call('offer_options', { options }), ctx('COMMERCIAL'));

    it('has a strict schema with a list of option titles', () => {
      expect(toolHandlerFor('offer_options', options).jsonSchema).toEqual({
        type: 'object',
        properties: {
          options: {
            type: 'array',
            items: { type: 'string' },
            description: expect.any(String) as unknown,
          },
        },
        required: ['options'],
        additionalProperties: false,
      });
    });

    it('plans 2 or 3 cleaned options as reply buttons', () => {
      expect(offer([' Inicial ', 'Pro', 'Ventas'])).toMatchObject({
        ok: true,
        effect: {
          kind: 'reply_buttons',
          buttons: [
            { id: 'option_1', title: 'Inicial' },
            { id: 'option_2', title: 'Pro' },
            { id: 'option_3', title: 'Ventas' },
          ],
        },
      });
    });

    it('accepts a single option (one button) but rejects none or 4, titles over 20 characters, links and repeats', () => {
      expect(offer(['🧪 Probar la demo'])).toMatchObject({ ok: true });
      expectRejected(offer([]), 'invalid_arguments');
      expectRejected(offer(['a', 'b', 'c', 'd']), 'invalid_arguments');
      expectRejected(offer(['a', 'x'.repeat(21)]), 'invalid_arguments');
      expectRejected(offer(['a', 'www.evil.test']), 'invalid_arguments');
      expectRejected(offer(['Pro', 'pro']), 'invalid_arguments');
    });

    it('a second call in the same reply is accepted and replaces the first, in both modes', () => {
      // Rejecting it made the model retry until it ran out of rounds.
      for (const mode of ['DEMO', 'COMMERCIAL'] as const) {
        expect(
          planToolCall(
            call('offer_options', { options: ['Sí', 'No'] }),
            ctx(mode, [
              {
                kind: 'reply_buttons',
                buttons: [{ id: 'option_1', title: 'Antes' }],
              },
            ]),
          ),
        ).toMatchObject({ ok: true });
      }
      expect(
        offeredButtons([
          {
            kind: 'reply_buttons',
            buttons: [{ id: 'option_1', title: 'Antes' }],
          },
          {
            kind: 'reply_buttons',
            buttons: [{ id: 'option_1', title: 'Después' }],
          },
        ]),
      ).toEqual([{ id: 'option_1', title: 'Después' }]);
    });
  });

  describe('request_handoff', () => {
    it('is allowed in both modes and keeps a cleaned reason', () => {
      for (const mode of ['COMMERCIAL', 'DEMO'] as const) {
        expect(
          planToolCall(
            call('request_handoff', { reason: 'quiere\tprecios' }),
            ctx(mode),
          ),
        ).toMatchObject({
          ok: true,
          effect: { kind: 'request_handoff', reason: 'quiere precios' },
        });
      }
      expectRejected(
        planToolCall(
          call('request_handoff', { reason: null, now: true }),
          ctx('DEMO'),
        ),
        'invalid_arguments',
      );
    });
  });

  describe('without the demo (demoEnabled false)', () => {
    it('register_demo_request is not offered', () => {
      const names = (mode: ToolContext['mode'], demoEnabled: boolean) =>
        toolDefinitionsFor(mode, {
          ...options,
          demoEnabled,
          ...(mode === 'DEMO' ? { demo: insurance } : {}),
        }).map((t) => t.name);

      expect(names('DEMO', false)).not.toContain('register_demo_request');
      expect(names('DEMO', false)).toContain('request_handoff');
      expect(names('DEMO', true)).toContain('register_demo_request');
      expect(names('COMMERCIAL', false)).toEqual([
        'save_lead',
        'request_handoff',
        'offer_options',
      ]);
    });

    it('register_demo_request is rejected if the model calls it anyway', () => {
      expectRejected(
        planToolCall(
          call('register_demo_request', booking()),
          ctx('DEMO', [], false),
        ),
        'tool_not_allowed',
      );
    });
  });
});

describe('search_catalog', () => {
  const chocolate = {
    name: 'Chocolate amargo',
    description: 'Cacao 70%',
    category: 'Helados',
    price: 1500,
    currency: 'ARS',
    attributes: {},
  };
  const search = vi.fn<CatalogReader['search']>();
  const withCatalog = (mode: ToolContext['mode'] = 'COMMERCIAL') => ({
    ...ctx(mode),
    catalog: { search },
  });
  const args = { query: ' chocolate  amrgo ', category: null, max_price: 2000 };

  beforeEach(() => {
    search.mockReset();
  });

  it('is offered only to a business with a catalog, and only in commercial mode', () => {
    const names = (
      opts: ToolOptions,
      mode: ToolContext['mode'] = 'COMMERCIAL',
    ) => toolDefinitionsFor(mode, opts).map((t) => t.name);

    expect(names(options)).not.toContain('search_catalog');
    expect(names({ ...options, catalog: noCatalog })).toContain(
      'search_catalog',
    );
    expect(
      names({ ...options, catalog: noCatalog, demo: insurance }, 'DEMO'),
    ).not.toContain('search_catalog');
  });

  it('searches with the cleaned arguments and plans no effect', async () => {
    search.mockResolvedValue([chocolate]);

    const result = await runToolCall(
      call('search_catalog', args),
      withCatalog(),
    );

    expect(search).toHaveBeenCalledWith({
      query: 'chocolate amrgo',
      category: null,
      maxPrice: 2000,
    });
    expect(result).toEqual({
      ok: true,
      effect: null,
      output: JSON.stringify({ ok: true, items: [chocolate] }),
    });
  });

  it('says so when nothing is found', async () => {
    search.mockResolvedValue([]);

    const result = await runToolCall(
      call('search_catalog', args),
      withCatalog(),
    );

    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      items: [],
      note: 'Sin resultados en el catálogo',
    });
  });

  it('is rejected without a catalog, in the demo, with bad arguments or through planToolCall', async () => {
    const rejected = async (c: ToolContext, a: unknown = args) =>
      (await runToolCall(call('search_catalog', a), c)).ok;

    expect(await rejected(ctx('COMMERCIAL'))).toBe(false);
    expect(await rejected(withCatalog('DEMO'))).toBe(false);
    expect(await rejected(withCatalog(), { ...args, query: '  ' })).toBe(false);
    expect(await rejected(withCatalog(), { ...args, max_price: -1 })).toBe(
      false,
    );
    expect(await rejected(withCatalog(), { query: 'x' })).toBe(false);
    expect(
      planToolCall(call('search_catalog', args), withCatalog()),
    ).toMatchObject({
      ok: false,
      reason: 'read_tool',
    });
    expect(search).not.toHaveBeenCalled();
  });
});
