import {
  type HistoryMessage,
  historyContextIds,
  historyWhere,
  toHistoryItems,
} from './history.js';

const row = (
  direction: 'INBOUND' | 'OUTBOUND',
  content: string,
  media: Partial<HistoryMessage> = {},
): HistoryMessage => ({
  direction,
  content,
  mediaKind: null,
  mediaMime: null,
  mediaFilename: null,
  transcript: null,
  ...media,
});

describe('history', () => {
  it('turns attachments into text: transcripts for audio, labels for images and PDFs', () => {
    expect(
      toHistoryItems([
        row('INBOUND', '[audio]', {
          mediaKind: 'audio',
          transcript: 'quiero un kilo',
        }),
        row('INBOUND', '[audio]', { mediaKind: 'audio' }),
        row('INBOUND', '¿Tienen esta?', { mediaKind: 'image' }),
        row('INBOUND', '[image]', { mediaKind: 'image' }),
        row('INBOUND', 'Mi pedido', {
          mediaKind: 'document',
          mediaMime: 'application/pdf',
          mediaFilename: 'pedido.pdf',
        }),
        row('INBOUND', 'Ubicación: KUBBO (1, 2)', { mediaKind: 'location' }),
        row('INBOUND', '[video]', { mediaKind: 'video' }),
      ]).map((item) => (item.kind === 'message' ? item.content : null)),
    ).toEqual([
      '[Audio transcrito] quiero un kilo',
      '[Audio]',
      '[Imagen] ¿Tienen esta?',
      '[Imagen]',
      '[PDF: pedido.pdf] Mi pedido',
      'Ubicación: KUBBO (1, 2)',
      '[video]',
    ]);
  });

  it('maps inbound to user and outbound to assistant, keeping order', () => {
    expect(
      toHistoryItems([
        row('INBOUND', 'hola'),
        row('OUTBOUND', '¡Hola! ¿Cómo te llamás?'),
        row('INBOUND', 'Ana'),
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

  it('filters by the remembered contexts, excluding the current message, pending inbound, failed sends and system messages', () => {
    expect(historyWhere(['ctx-1', 'ctx-0'], 'msg-9')).toEqual({
      contextId: { in: ['ctx-1', 'ctx-0'] },
      id: { not: 'msg-9' },
      // Inbox notes such as "Damián tomó la conversación" are not chat.
      type: { not: 'SYSTEM' },
      OR: [
        { direction: 'INBOUND', status: 'PROCESSED' },
        { direction: 'OUTBOUND', status: { not: 'FAILED' } },
      ],
    });
  });

  describe('historyContextIds', () => {
    // Newest first, as the generator reads them.
    const ctx = (
      id: string,
      mode: 'COMMERCIAL' | 'DEMO',
      endReason: 'RESET' | 'MODE_SWITCH' | null = 'MODE_SWITCH',
    ) => ({ id, mode, endReason });

    it('back from the demo, the commercial chat before it is remembered, never the demo', () => {
      expect(
        historyContextIds('COMMERCIAL', [
          ctx('c2', 'COMMERCIAL', null),
          ctx('d1', 'DEMO'),
          ctx('c1', 'COMMERCIAL'),
        ]),
      ).toEqual(['c2', 'c1']);
    });

    it('goes back through several demos, up to a reset', () => {
      expect(
        historyContextIds('COMMERCIAL', [
          ctx('c3', 'COMMERCIAL', null),
          ctx('d2', 'DEMO'),
          ctx('c2', 'COMMERCIAL'),
          ctx('d1', 'DEMO'),
          ctx('c1', 'COMMERCIAL', 'RESET'),
          ctx('c0', 'COMMERCIAL'),
        ]),
      ).toEqual(['c3', 'c2']);
    });

    it('the demo only sees its own context', () => {
      expect(
        historyContextIds('DEMO', [
          ctx('d2', 'DEMO', null),
          ctx('c1', 'COMMERCIAL'),
          ctx('d1', 'DEMO'),
        ]),
      ).toEqual(['d2']);
    });

    it('a first context is just itself', () => {
      expect(
        historyContextIds('COMMERCIAL', [ctx('c1', 'COMMERCIAL', null)]),
      ).toEqual(['c1']);
    });
  });
});
