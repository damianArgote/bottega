import { captionOf, isPdfMime } from '../media/attachment-text.js';
import type { AiInputItem } from '../ai/ai.provider.js';
import {
  type ContextEndReason,
  type ConversationMode,
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
  type Prisma,
} from '../generated/prisma/client.js';

/**
 * The contexts whose messages the model remembers, newest first. The demo
 * only sees its own. Back in commercial mode, it also sees the commercial
 * chat before each demo (never the demo itself), up to the last reset.
 * `contexts`: the conversation's contexts, newest (the active one) first.
 */
export function historyContextIds(
  mode: ConversationMode,
  contexts: readonly {
    id: string;
    mode: ConversationMode;
    endReason: ContextEndReason | null;
  }[],
): string[] {
  const [active, ...older] = contexts;
  if (!active) {
    return [];
  }
  const ids = [active.id];
  if (mode === 'DEMO') {
    return ids;
  }
  for (const context of older) {
    if (context.endReason !== 'MODE_SWITCH') {
      break;
    }
    if (context.mode === 'COMMERCIAL') {
      ids.push(context.id);
    }
  }
  return ids;
}

/**
 * Messages of the given contexts that the model may see: processed inbound
 * messages (not later ones still waiting in the queue) and every outbound
 * reply except FAILED ones (never delivered). The current message is
 * excluded here and appended last by the caller.
 */
export function historyWhere(
  contextIds: readonly string[],
  currentMessageId: string,
): Prisma.MessageWhereInput {
  return {
    contextId: { in: [...contextIds] },
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

/** The columns history reads from each message. */
export type HistoryMessage = Pick<
  Message,
  | 'direction'
  | 'content'
  | 'mediaKind'
  | 'mediaMime'
  | 'mediaFilename'
  | 'transcript'
>;

/** Maps stored messages (oldest first) to model input items. */
export function toHistoryItems(
  messages: readonly HistoryMessage[],
): AiInputItem[] {
  return messages.map((message) => ({
    kind: 'message',
    role: message.direction === MessageDirection.INBOUND ? 'user' : 'assistant',
    content: historyText(message),
  }));
}

/**
 * An inbound attachment as text: images and PDFs are not sent again (they
 * cost tokens), audio goes as its transcript.
 */
export function historyText(message: HistoryMessage): string {
  if (message.direction !== MessageDirection.INBOUND || !message.mediaKind) {
    return message.content;
  }
  const caption = captionOf(message);
  const withCaption = (label: string) =>
    caption ? `${label} ${caption}` : label;
  switch (message.mediaKind) {
    case 'audio':
      return message.transcript
        ? `[Audio transcrito] ${message.transcript}`
        : '[Audio]';
    case 'image':
      return withCaption('[Imagen]');
    case 'document':
      return withCaption(
        `[${isPdfMime(message.mediaMime) ? 'PDF' : 'Documento'}: ${message.mediaFilename ?? 'sin nombre'}]`,
      );
    default:
      return message.content;
  }
}
