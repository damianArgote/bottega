import type { AiInputItem } from '../ai/ai.provider.js';
import {
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
  type Prisma,
} from '../generated/prisma/client.js';

/**
 * Messages of the active context that the model may see: processed inbound
 * messages (not later ones still waiting in the queue) and every outbound
 * reply except FAILED ones (never delivered). The current message is
 * excluded here and appended last by the caller.
 */
export function historyWhere(
  contextId: string,
  currentMessageId: string,
): Prisma.MessageWhereInput {
  return {
    contextId,
    id: { not: currentMessageId },
    // Inbox notes such as "Damián tomó la conversación" are not chat.
    type: { not: MessageType.SYSTEM },
    OR: [
      { direction: MessageDirection.INBOUND, status: MessageStatus.PROCESSED },
      {
        direction: MessageDirection.OUTBOUND,
        status: { not: MessageStatus.FAILED },
      },
    ],
  };
}

/** Maps stored messages (oldest first) to model input items. */
export function toHistoryItems(
  messages: readonly Pick<Message, 'direction' | 'content'>[],
): AiInputItem[] {
  return messages.map((message) => ({
    kind: 'message',
    role: message.direction === MessageDirection.INBOUND ? 'user' : 'assistant',
    content: message.content,
  }));
}
