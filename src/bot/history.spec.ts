import { historyWhere, toHistoryItems } from './history.js';

describe('history', () => {
  it('maps inbound to user and outbound to assistant, keeping order', () => {
    expect(
      toHistoryItems([
        { direction: 'INBOUND', content: 'hola' },
        { direction: 'OUTBOUND', content: '¡Hola! ¿Cómo te llamás?' },
        { direction: 'INBOUND', content: 'Ana' },
      ]),
    ).toEqual([
      { kind: 'message', role: 'user', content: 'hola' },
      {
        kind: 'message',
        role: 'assistant',
        content: '¡Hola! ¿Cómo te llamás?',
      },
      { kind: 'message', role: 'user', content: 'Ana' },
    ]);
  });

  it('filters by the active context, excluding the current message, pending inbound, failed sends and system messages', () => {
    expect(historyWhere('ctx-1', 'msg-9')).toEqual({
      contextId: 'ctx-1',
      id: { not: 'msg-9' },
      // Inbox notes such as "Damián tomó la conversación" are not chat.
      type: { not: 'SYSTEM' },
      OR: [
        { direction: 'INBOUND', status: 'PROCESSED' },
        { direction: 'OUTBOUND', status: { not: 'FAILED' } },
      ],
    });
  });
});
