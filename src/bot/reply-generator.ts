import { Logger } from '@nestjs/common';
import type { ConversationMode } from '../generated/prisma/client.js';
import { echoReply, UNSUPPORTED_REPLY } from './echo-replies.js';

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
}

/**
 * Produces the reply texts for one non-command inbound message, in send
 * order (commands are handled deterministically by CommandService).
 * Called at most once per job once its result is persisted (two-phase job):
 * the worker stores the replies before sending any of them.
 * Stage 4b replaces the ai implementation with the AI pipeline.
 */
export interface ReplyGenerator {
  generate(input: ReplyInput): Promise<string[]>;
}

export const REPLY_GENERATOR = Symbol('REPLY_GENERATOR');

/** BOT_REPLY_MODE=echo: quote the text back, or hint that only text works. */
export class EchoReplyGenerator implements ReplyGenerator {
  generate({ message }: ReplyInput): Promise<string[]> {
    return Promise.resolve([
      message.type === 'TEXT' ? echoReply(message.content) : UNSUPPORTED_REPLY,
    ]);
  }
}

/**
 * BOT_REPLY_MODE=ai placeholder until Stage 4b: answers nothing (no fake
 * reply) and warns, so the job completes without outbound messages.
 */
export class UnimplementedAiReplyGenerator implements ReplyGenerator {
  private readonly logger = new Logger(UnimplementedAiReplyGenerator.name);

  generate({ message }: ReplyInput): Promise<string[]> {
    this.logger.warn(
      `BOT_REPLY_MODE=ai is not implemented yet; message ${message.id} left unanswered`,
    );
    return Promise.resolve([]);
  }
}
