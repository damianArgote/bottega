import type { AiResponse } from '../ai/ai.provider.js';
import { runAgentTurn, type ToolCallTrace } from './agent-turn.js';
import type { ToolContext } from './tools/tool.js';

const tools = {
  mode: 'COMMERCIAL',
  barbershop: {},
  demoEnabled: false,
  leadFields: [],
} as unknown as Omit<ToolContext, 'planned'>;

const unknownTool: AiResponse = {
  outputText: '',
  toolCalls: [{ callId: 'c1', name: 'run_sql', arguments: '{}' }],
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'm',
};

describe('runAgentTurn', () => {
  it('reports a rejected tool call as it happens, before a later call fails', async () => {
    const seen: ToolCallTrace[] = [];
    const call = vi
      .fn()
      .mockResolvedValueOnce(unknownTool)
      .mockRejectedValueOnce(new Error('retry later'));

    await expect(
      runAgentTurn(
        {
          request: {
            model: 'm',
            instructions: 'i',
            tools: [],
            maxOutputTokens: 1,
          },
          input: [{ kind: 'message', role: 'user', content: 'hola' }],
          tools,
        },
        call,
        (trace) => seen.push(trace),
      ),
    ).rejects.toThrow('retry later');

    expect(seen).toEqual([
      {
        name: 'run_sql',
        arguments: '{}',
        accepted: false,
        reason: 'unknown_tool',
      },
    ]);
  });

  it('on the last round the model may not call tools, so it has to answer', async () => {
    const offer = (title: string): AiResponse => ({
      outputText: '',
      toolCalls: [
        {
          callId: title,
          name: 'offer_options',
          arguments: JSON.stringify({ options: [title] }),
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    });
    const call = vi
      .fn()
      .mockResolvedValueOnce(offer('Uno'))
      .mockResolvedValueOnce(offer('Dos'))
      .mockResolvedValueOnce({
        ...offer('x'),
        toolCalls: [],
        outputText: 'Listo.',
      });

    const outcome = await runAgentTurn(
      {
        request: {
          model: 'm',
          instructions: 'i',
          tools: [],
          maxOutputTokens: 1,
        },
        input: [{ kind: 'message', role: 'user', content: 'hola' }],
        tools,
      },
      call,
    );

    expect(
      call.mock.calls.map(([r]) => (r as { toolChoice?: string }).toolChoice),
    ).toEqual([undefined, undefined, 'none']);
    expect(outcome).toMatchObject({ kind: 'text', text: 'Listo.' });
    expect(outcome.kind === 'text' && outcome.effects).toEqual([
      { kind: 'reply_buttons', buttons: [{ id: 'option_1', title: 'Uno' }] },
      { kind: 'reply_buttons', buttons: [{ id: 'option_1', title: 'Dos' }] },
    ]);
  });

  it('a model that still calls tools on the last round exceeds the rounds', async () => {
    const call = vi.fn().mockResolvedValue(unknownTool);

    const outcome = await runAgentTurn(
      {
        request: {
          model: 'm',
          instructions: 'i',
          tools: [],
          maxOutputTokens: 1,
        },
        input: [{ kind: 'message', role: 'user', content: 'hola' }],
        tools,
      },
      call,
    );

    expect(outcome.kind).toBe('rounds_exceeded');
    expect(call).toHaveBeenCalledTimes(3);
  });
});
