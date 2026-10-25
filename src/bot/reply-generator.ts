import type { ReplyButton } from '../whatsapp/whatsapp.client.js';
import type { ConversationMode } from '../generated/prisma/client.js';
import { echoReply, UNSUPPORTED_REPLY } from './echo-replies.js';
import type { PlannedEffect } from './tools/tool.js';

/** What a generator gets to produce the replies for one inbound message. */
export interface ReplyInput {
  conversationId: string;
  /** Mode of the conversation (selects the ModeProfile). */
  mode: ConversationMode;
  /**
   * Active context. The inbound message belongs to it and the replies are
   * stored in it; history must be read from this context only.
   */
  contextId: string;
  message: {
    id: string;
    type: 'TEXT' | 'UNSUPPORTED' | 'SYSTEM';
    content: string;
  };
  /**
   * True on the job's last attempt: a generator must then answer with a
   * controlled fallback instead of failing with a retryable error.
   */
  isLastAttempt: boolean;
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

/** BOT_REPLY_MODE=echo: quote the text back, or hint that only text works. */
export class EchoReplyGenerator implements ReplyGenerator {
  generate({ message }: ReplyInput): Promise<GeneratedReply> {
    return Promise.resolve({
      replies: [
        message.type === 'TEXT'
          ? echoReply(message.content)
          : UNSUPPORTED_REPLY,
      ],
      effects: [],
    });
  }
}
