import type { ReplyButton } from '../whatsapp/whatsapp.client.js';
import type { ConversationMode } from '../generated/prisma/client.js';
import { echoReply, UNSUPPORTED_REPLY } from './echo-replies.js';
import type { PreparedAttachment } from './attachment-preparer.js';
import type { PlannedEffect } from './tools/tool.js';

/** One inbound message of a turn. */
export interface ReplyMessage {
  id: string;
  type: 'TEXT' | 'UNSUPPORTED' | 'SYSTEM';
  content: string;
  /**
   * The attachment, prepared by AttachmentPreparer (transcript, image or
   * PDF, or why it was not processed). Absent for text.
   */
  attachment?: PreparedAttachment;
}

/** What a generator gets to produce the replies for one turn. */
export interface ReplyInput {
  conversationId: string;
  /** Mode of the conversation (selects the ModeProfile). */
  mode: ConversationMode;
  /**
   * Active context. The inbound message belongs to it and the replies are
   * stored in it; history must be read from this context only.
   */
  contextId: string;
  /** The message that created the job: the key of what the turn does. */
  message: ReplyMessage;
  /** Messages written right after it, answered in this same turn, in order. */
  grouped?: readonly ReplyMessage[];
  /**
   * True on the job's last attempt: a generator must then answer with a
   * controlled fallback instead of failing with a retryable error.
   */
  isLastAttempt: boolean;
}

/** Every inbound message of the turn, in order. */
export function turnMessages(input: ReplyInput): ReplyMessage[] {
  return [input.message, ...(input.grouped ?? [])];
}

export interface GeneratedReply {
  /** Reply texts in send order. */
  replies: string[];
  /**
   * Validated tool effects, applied by the worker in the same transaction
   * that persists the replies (never by the generator itself).
   */
  effects: PlannedEffect[];
  /** Reply buttons for the last reply (offer_options); none by default. */
  buttons?: ReplyButton[];
}

/**
 * Produces the replies (and planned effects) for one non-command inbound
 * message (commands are handled deterministically by CommandService).
 * Called again on a retry until its result is persisted (two-phase job), so
 * it must not write business data itself.
 */
export interface ReplyGenerator {
  generate(input: ReplyInput): Promise<GeneratedReply>;
}

export const REPLY_GENERATOR = Symbol('REPLY_GENERATOR');

/** BOT_REPLY_MODE=echo: quote the text back, or say it cannot open files. */
export class EchoReplyGenerator implements ReplyGenerator {
  generate(input: ReplyInput): Promise<GeneratedReply> {
    const { message } = input;
    const texts = turnMessages(input)
      .filter((m) => m.type === 'TEXT')
      .map((m) => m.content);
    return Promise.resolve({
      replies: [
        texts.length > 0
          ? echoReply(texts.join('\n'))
          : message.attachment?.kind === 'rejected'
            ? message.attachment.reply
            : UNSUPPORTED_REPLY,
      ],
      effects: [],
    });
  }
}
