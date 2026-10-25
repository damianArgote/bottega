import type { Prisma } from '../generated/prisma/client.js';
import { onInbound, onOutbound } from './conversation-state.js';

/**
 * Writes that make a conversation change in the inbox. Each one UPDATEs the
 * conversation row, so the conversation_track_change trigger gives it a new
 * change_txid (the /changes cursor) and raises its version. Run them in the
 * same transaction as the message write they belong to.
 */
type Tx = Pick<Prisma.TransactionClient, 'conversation'>;

const stateSelect = {
  status: true,
  assignedToId: true,
  unreadCount: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  windowExpiresAt: true,
} as const;

/** A new message from the user (see onInbound). */
export async function recordInboundActivity(
  tx: Tx,
  conversationId: string,
  message: { occurredAt: Date; text: string },
): Promise<void> {
  const state = await tx.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: stateSelect,
  });
  await tx.conversation.update({
    where: { id: conversationId },
    data: onInbound(state, { ...message, now: new Date() }),
  });
}

/** A new message to the user, from the bot or a person (see onOutbound). */
export async function recordOutboundActivity(
  tx: Tx,
  conversationId: string,
  text: string,
): Promise<void> {
  await tx.conversation.update({
    where: { id: conversationId },
    data: onOutbound({ text, now: new Date() }),
  });
}

/** Something else the inbox shows changed (a send result, a tick). */
export async function touchConversations(
  tx: Tx,
  where: Prisma.ConversationWhereInput,
): Promise<void> {
  await tx.conversation.updateMany({ where, data: { updatedAt: new Date() } });
}
