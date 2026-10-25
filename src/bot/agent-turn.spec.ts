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
});
