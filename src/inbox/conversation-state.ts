/**
 * Inbox state rules of a conversation, pure (no Nest, no Prisma) so they are
 * unit tested. Callers apply the returned changes to the row inside their
 * transaction; every UPDATE of the row makes the database trigger assign a
 * new change_txid and raise version (see the 04 migration).
 */

export type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED';

export interface ConversationState {
  status: ConversationStatus;
  assignedToId: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  windowExpiresAt: Date | null;
}

export type StateChange = Partial<ConversationState>;

export const PREVIEW_MAX_LENGTH = 120;
/** WhatsApp's customer service window after the user's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One line, at most PREVIEW_MAX_LENGTH characters (not UTF-16 units). */
export function previewOf(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > PREVIEW_MAX_LENGTH
    ? `${chars.slice(0, PREVIEW_MAX_LENGTH - 1).join('')}…`
    : chars.join('');
}

/**
 * A message from the user: one more unread, preview and last message time
 * (server time, so the list order never depends on the sender's clock), and
 * the window extended to 24 h after it was sent, never moved back. A
 * resolved conversation opens again, unassigned.
 */
export function onInbound(
  state: ConversationState,
  message: { occurredAt: Date; text: string; now: Date },
): StateChange {
  const opensUntil = new Date(message.occurredAt.getTime() + SERVICE_WINDOW_MS);
  return {
    unreadCount: state.unreadCount + 1,
    lastMessageAt: message.now,
    lastMessagePreview: previewOf(message.text),
    windowExpiresAt:
      state.windowExpiresAt && state.windowExpiresAt > opensUntil
        ? state.windowExpiresAt
        : opensUntil,
    ...(state.status === 'RESOLVED'
      ? { status: 'OPEN' as const, assignedToId: null }
      : {}),
  };
}

/** A message to the user (bot or person): preview and last message time. */
export function onOutbound(message: { text: string; now: Date }): StateChange {
  return {
    lastMessageAt: message.now,
    lastMessagePreview: previewOf(message.text),
  };
}

/** Changes to who attends a conversation (status, assignee, bot pause). */
export type AttendanceChange = Partial<{
  status: ConversationStatus;
  assignedToId: string | null;
  paused: boolean;
}>;

/** The bot answers only when nobody is assigned and it is not paused. */
export function botMayReply(state: {
  assignedToId: string | null;
  paused: boolean;
}): boolean {
  return state.assignedToId === null && !state.paused;
}

/** The bot handed off ("humano" or request_handoff): waiting in "Pendientes". */
export function onHandoff(): AttendanceChange {
  return { status: 'PENDING', assignedToId: null };
}

/** A person takes it (409 rules live in the service). */
export function take(userId: string): AttendanceChange {
  return { assignedToId: userId, status: 'OPEN' };
}

/** Nobody attends, and the bot stays quiet until it is handed back. */
export function release(): AttendanceChange {
  return { assignedToId: null, paused: true };
}

/** "Devolver al bot". */
export function handBack(): AttendanceChange {
  return { assignedToId: null, paused: false, status: 'OPEN' };
}

export function resolve(): AttendanceChange {
  return { status: 'RESOLVED', assignedToId: null, paused: false };
}

/**
 * When the 24 h window closes. Normally windowExpiresAt; but when it is
 * missing or older than the last inbound message (rows the previous release
 * wrote during a deploy only have lastInboundAt), 24 h after that message.
 * A window Meta closed (131047 sets windowExpiresAt to now) stays closed:
 * "now" is never before the last inbound message.
 */
export function windowClosesAt(state: {
  windowExpiresAt: Date | null;
  lastInboundAt: Date | null;
}): Date | null {
  const { windowExpiresAt, lastInboundAt } = state;
  if (!lastInboundAt) {
    return windowExpiresAt;
  }
  return windowExpiresAt && windowExpiresAt >= lastInboundAt
    ? windowExpiresAt
    : new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);
}
