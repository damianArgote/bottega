import { DEFAULT_LEAD_FIELDS } from '../../agents/default-agent-profile.seed.js';
import { planToolCall, toolDefinitionsFor } from './registry.js';
import type { ToolContext } from './tool.js';

const tags = {
  tags: [
    {
      key: 'mayorista',
      name: 'Mayorista',
      botHint: 'Compra por cantidad para revender o pide precio por bulto',
    },
    { key: 'proveedor', name: 'Proveedor', botHint: null },
  ],
};

const ctx = (withTags = true): ToolContext => ({
  mode: 'COMMERCIAL',
  planned: [],
  demoEnabled: false,
  leadFields: DEFAULT_LEAD_FIELDS,
  modules: withTags ? { tags } : {},
});

const call = (args: unknown) => ({
  callId: 'call_1',
  name: 'tag_contact',
  arguments: JSON.stringify(args),
});

describe('tag_contact', () => {
  it('is offered only to a business with BOT tags, its keys enumerated', () => {
    const offered = (withTags: boolean) =>
      toolDefinitionsFor('COMMERCIAL', ctx(withTags)).find(
        (t) => t.name === 'tag_contact',
      );
    expect(offered(false)).toBeUndefined();
    expect(toolDefinitionsFor('DEMO', ctx())).not.toContainEqual(
      expect.objectContaining({ name: 'tag_contact' }),
    );

    const tool = offered(true)!;
    expect(tool.parameters).toMatchObject({
      properties: {
        add: { type: 'array', items: { enum: ['mayorista', 'proveedor'] } },
        remove: { type: 'array', items: { enum: ['mayorista', 'proveedor'] } },
      },
      required: ['add', 'remove'],
      additionalProperties: false,
    });
    expect(tool.description).toContain(
      'mayorista: "Mayorista". Cuándo: Compra por cantidad para revender o pide precio por bulto',
    );
    expect(tool.description).toContain('información del negocio');
  });

  it('plans the keys as an effect, deduplicated, without saying which ones', () => {
    const result = planToolCall(
      call({ add: ['mayorista', 'mayorista', 'otra'], remove: ['proveedor'] }),
      ctx(),
    );
    expect(result).toMatchObject({
      ok: true,
      effect: {
        kind: 'tag_contact',
        add: ['mayorista', 'otra'],
        remove: ['proveedor'],
      },
    });
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      note: 'Listo. No le digas a la persona qué etiquetas tiene.',
    });
  });

  it('is rejected without tags, with nothing to do or with bad arguments', () => {
    expect(
      planToolCall(call({ add: ['mayorista'], remove: [] }), ctx(false)),
    ).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
    expect(planToolCall(call({ add: [], remove: [] }), ctx())).toMatchObject({
      ok: false,
      reason: 'plan_rejected',
    });
    expect(
      planToolCall(call({ add: 'mayorista', remove: [] }), ctx()),
    ).toMatchObject({ ok: false, reason: 'invalid_arguments' });
    expect(
      planToolCall(call({ add: ['mayorista'], remove: [], x: 1 }), ctx()),
    ).toMatchObject({ ok: false, reason: 'invalid_arguments' });
  });
});
