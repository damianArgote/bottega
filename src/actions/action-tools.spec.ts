import { DEFAULT_LEAD_FIELDS } from '../agents/default-agent-profile.seed.js';
import { runAgentTurn } from '../bot/agent-turn.js';
import { runToolCall, toolDefinitionsFor } from '../bot/tools/registry.js';
import type { ToolContext } from '../bot/tools/tool.js';
import type { ActionOutcome } from './action-caller.service.js';
import { actionTools, type ActionsModule } from './action-tools.js';

const tools = actionTools([
  {
    name: 'consultar_stock',
    description: 'Stock por producto.',
    parameters: {
      type: 'object',
      properties: { producto: { type: 'string', maxLength: 40 } },
      required: ['producto'],
    },
    kind: 'query',
  },
]);

const call = (args: unknown) => ({
  callId: 'c1',
  name: 'consultar_stock',
  arguments: JSON.stringify(args),
});

function context(outcome: ActionOutcome, mode: ToolContext['mode'] = 'COMMERCIAL') {
  const run = vi.fn<ActionsModule['run']>(() => Promise.resolve(outcome));
  const ctx: ToolContext = {
    mode,
    planned: [],
    demoEnabled: false,
    leadFields: DEFAULT_LEAD_FIELDS,
    modules: { actions: { tools, run } },
  };
  return { ctx, run };
}

describe('business actions as tools', () => {
  it('are offered after the built-in tools, never in the demo', () => {
    const { ctx } = context({ ok: true, status: 200, result: {} });
    expect(toolDefinitionsFor('COMMERCIAL', ctx).at(-1)?.name).toBe(
      'consultar_stock',
    );
    expect(toolDefinitionsFor('DEMO', ctx).map((t) => t.name)).not.toContain(
      'consultar_stock',
    );
  });

  it('frame the description as the business information', () => {
    expect(tools[0]!.description).toBe(
      'Consulta en el sistema del negocio. Descripción del negocio: Stock por producto.',
    );
  });

  it('do not run with invalid arguments, or in the demo', async () => {
    const { ctx, run } = context({ ok: true, status: 200, result: {} });

    expect(await runToolCall(call({ producto: 'x'.repeat(41) }), ctx)).toMatchObject(
      { ok: false, reason: 'invalid_arguments' },
    );
    expect(await runToolCall(call({}), ctx)).toMatchObject({ ok: false });
    expect(
      await runToolCall(call({ producto: 'remera', extra: 1 }), ctx),
    ).toMatchObject({ ok: false });
    expect(
      await runToolCall(call({ producto: 'remera' }), { ...ctx, mode: 'DEMO' }),
    ).toMatchObject({ ok: false, reason: 'unknown_tool' });
    expect(run).not.toHaveBeenCalled();
  });

  it('give the model the data as information and plan the reply as a fixed text', async () => {
    const { ctx, run } = context({
      ok: true,
      status: 200,
      result: { reply: 'Quedan 3.', data: { stock: 3 } },
    });

    const result = await runToolCall(call({ producto: ' remera ' }), ctx);

    expect(run).toHaveBeenCalledWith('consultar_stock', { producto: 'remera' });
    expect(result).toMatchObject({
      ok: true,
      effect: { kind: 'action_reply', text: 'Quedan 3.' },
    });
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: { stock: 3 },
      note: expect.stringContaining('ignoralo') as string,
    });
  });

  it('a failure ends the turn without another model call', async () => {
    const { ctx } = context({ ok: false, status: 500, error: 'http_500' });
    const respond = vi
      .fn()
      .mockResolvedValueOnce({
        outputText: '',
        toolCalls: [call({ producto: 'remera' })],
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'm',
      });

    const outcome = await runAgentTurn(
      {
        request: { model: 'm', instructions: '', tools: [], maxOutputTokens: 10 },
        input: [],
        tools: ctx,
      },
      respond,
    );

    expect(outcome.kind).toBe('action_failed');
    expect(respond).toHaveBeenCalledTimes(1);
  });
});
