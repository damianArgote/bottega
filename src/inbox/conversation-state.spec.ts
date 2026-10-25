import {
  type ConversationState,
  onInbound,
  onOutbound,
  PREVIEW_MAX_LENGTH,
  previewOf,
} from './conversation-state.js';

const NOW = new Date('2026-10-25T12:00:00Z');
const base: ConversationState = {
  status: 'OPEN',
  assignedToId: null,
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
  windowExpiresAt: null,
};

describe('previewOf', () => {
  it('is one line of at most 120 characters', () => {
    expect(previewOf('  Hola\n\tqué tal  ')).toBe('Hola qué tal');
    const long = previewOf('a'.repeat(300));
    expect(Array.from(long)).toHaveLength(PREVIEW_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    // Counts characters, not UTF-16 units.
    expect(Array.from(previewOf('😀'.repeat(200)))).toHaveLength(120);
  });
});

describe('onInbound', () => {
  const inbound = (occurredAt: string, text = 'hola') => ({
    occurredAt: new Date(occurredAt),
    text,
    now: NOW,
  });

  it('adds one unread, updates the preview and last message time, and opens the window for 24 h', () => {
    expect(
      onInbound({ ...base, unreadCount: 2 }, inbound('2026-10-25T11:59:00Z')),
    ).toEqual({
      unreadCount: 3,
      lastMessageAt: NOW,
      lastMessagePreview: 'hola',
      windowExpiresAt: new Date('2026-10-26T11:59:00Z'),
    });
  });

  it('never moves the window back', () => {
    const state = {
      ...base,
      windowExpiresAt: new Date('2026-10-27T00:00:00Z'),
    };

    expect(
      onInbound(state, inbound('2026-10-25T08:00:00Z')).windowExpiresAt,
    ).toEqual(new Date('2026-10-27T00:00:00Z'));
  });

  it('reopens a resolved conversation, unassigned', () => {
    expect(
      onInbound(
        { ...base, status: 'RESOLVED', assignedToId: 'u1' },
        inbound('2026-10-25T11:00:00Z'),
      ),
    ).toMatchObject({ status: 'OPEN', assignedToId: null });
  });

  it('keeps a pending or assigned conversation as it is', () => {
    const pending = onInbound(
      { ...base, status: 'PENDING' },
      inbound('2026-10-25T11:00:00Z'),
    );
    const assigned = onInbound(
      { ...base, assignedToId: 'u1' },
      inbound('2026-10-25T11:00:00Z'),
    );

    expect(pending).not.toHaveProperty('status');
    expect(pending).not.toHaveProperty('assignedToId');
    expect(assigned).not.toHaveProperty('assignedToId');
  });
});

describe('onOutbound', () => {
  it('updates the preview and last message time, not the unread count or the window', () => {
    expect(onOutbound({ text: '¡Hola!\nTe ayudo', now: NOW })).toEqual({
      lastMessageAt: NOW,
      lastMessagePreview: '¡Hola! Te ayudo',
    });
  });
});
