import {
  type MessageAuthor,
  MessageDirection,
  MessageStatus,
  MessageType,
  type Prisma,
} from '../generated/prisma/client.js';

/**
 * A note in the conversation's thread for the inbox ("Damián tomó la
 * conversación"). Never sent to WhatsApp (only QUEUED rows are sent) and
 * never part of the model's history (historyWhere excludes SYSTEM).
 */
export async function addSystemMessage(
  tx: Pick<Prisma.TransactionClient, 'message'>,
  message: {
    conversationId: string;
    contextId: string | null;
    author: MessageAuthor;
    text: string;
  },
): Promise<void> {
  await tx.message.create({
    data: {
      conversationId: message.conversationId,
      contextId: message.contextId,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.SYSTEM,
      content: message.text,
      status: MessageStatus.PROCESSED,
      author: message.author,
    },
  });
}
