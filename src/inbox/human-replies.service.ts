import {
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { SessionUser } from '../auth/auth.service.js';
import {
  type Message,
  MessageAuthor,
  MessageDirection,
  MessageStatus,
  MessageType,
  type Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../prisma/sql.js';
import { metaErrorKind } from '../whatsapp/meta-errors.js';
import {
  maskPhone,
  WHATSAPP_CLIENT_FACTORY,
  type SendOutcome,
  type WhatsAppClient,
  type WhatsAppClientFactory,
} from '../whatsapp/whatsapp.client.js';
import {
  recordOutboundActivity,
  touchConversations,
} from './conversation-activity.js';
import { take, windowClosesAt } from './conversation-state.js';
import { addSystemMessage } from './system-messages.js';

export type HumanReplyResult =
  | { outcome: 'sent'; messageId: string; waMessageId: string }
  | {
      outcome: 'rejected';
      messageId: string;
      code: string;
      retryable: boolean;
      detail: string;
    }
  | { outcome: 'uncertain'; messageId: string; detail: string }
  | {
      /** Same idempotency key as an earlier request: nothing was sent now. */
      outcome: 'replayed';
      messageId: string;
      status: MessageStatus;
      waMessageId: string | null;
    };

/** HTTP status per outcome, so `curl -f` fails on a rejection. */
export const REPLY_STATUS: Record<HumanReplyResult['outcome'], number> = {
  sent: HttpStatus.OK,
  replayed: HttpStatus.OK,
  uncertain: HttpStatus.ACCEPTED,
  rejected: HttpStatus.BAD_GATEWAY,
};

const UNCERTAIN_DETAIL =
  'Meta may or may not have accepted the message. It is NOT resent automatically: check the chat on the phone before sending it again.';

const WINDOW_CLOSED_MESSAGE =
  'The 24h customer service window is closed (the user has not written in the last 24 hours). WhatsApp only allows approved message templates outside the window, and this API does not send templates. Wait until the user writes again.';

export interface ReplyConversation {
  id: string;
  lineId: string;
  activeContextId: string | null;
  windowExpiresAt: Date | null;
  lastInboundAt: Date | null;
  contact: { waId: string };
}

/** The 24 h window is open until windowClosesAt (never written: closed). */
export function windowOpen(
  conversation: { windowExpiresAt: Date | null; lastInboundAt: Date | null },
  now = new Date(),
): boolean {
  const closesAt = windowClosesAt(conversation);
  return closesAt !== null && closesAt.getTime() > now.getTime();
}

/**
 * A text written by a person, sent now (admin API and inbox). The window is
 * checked before calling Meta (409 `WINDOW_CLOSED`). At most once: the row
 * goes QUEUED → SENDING → SENT / FAILED / UNCERTAIN and an uncertain send
 * is never retried; the same idempotency key never sends twice. Meta's
 * 131047 (window closed) moves the conversation's window to now. With an
 * inbox `author`, an unassigned conversation is taken by them, and one that
 * someone else has answers 409 `ALREADY_TAKEN`.
 */
@Injectable()
export class HumanRepliesService {
  private readonly logger = new Logger(HumanRepliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_CLIENT_FACTORY)
    private readonly clients: WhatsAppClientFactory,
  ) {}

  async send(input: {
    conversation: ReplyConversation;
    text: string;
    idempotencyKey: string;
    author?: SessionUser;
  }): Promise<HumanReplyResult> {
    const { conversation, text, idempotencyKey: key, author } = input;
    const previous = await this.findByKey(key);
    if (previous) {
      return replayed(previous, conversation.id);
    }
    if (!windowOpen(conversation)) {
      throw new ConflictException({
        message: WINDOW_CLOSED_MESSAGE,
        code: 'WINDOW_CLOSED',
      });
    }
    const contextId = conversation.activeContextId;
    if (!contextId) {
      throw new ConflictException('Conversation has no active context');
    }
    // Resolved before the row exists: a failure here must not leave a
    // QUEUED row that a retry with the same key would only replay.
    const recipient = conversation.contact.waId;
    const client = await this.clients.forLine(conversation.lineId);

    let row: Message;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        // The conversation row is locked before the message insert, like
        // every other path that adds messages, so message seqs commit in
        // order for the inbox's `after=<seq>` polling.
        const [locked] = await tx.$queryRaw<{ assignedToId: string | null }[]>`
          SELECT assigned_to_id AS "assignedToId" FROM conversation
          WHERE id = ${conversation.id}::uuid FOR UPDATE`;
        if (author) {
          await this.takeIfUnassigned(
            tx,
            conversation.id,
            contextId,
            author,
            locked?.assignedToId ?? null,
          );
        }
        const created = await tx.message.create({
          data: {
            conversationId: conversation.id,
            contextId,
            direction: MessageDirection.OUTBOUND,
            type: MessageType.TEXT,
            content: text,
            status: MessageStatus.QUEUED,
            author: MessageAuthor.HUMAN,
            idempotencyKey: key,
          },
        });
        await recordOutboundActivity(tx, conversation.id, text);
        return created;
      });
    } catch (error) {
      // A concurrent request with the same key won the insert.
      const existing = isUniqueViolation(error)
        ? await this.findByKey(key)
        : null;
      if (existing) {
        return replayed(existing, conversation.id);
      }
      throw error;
    }

    const result = await this.deliver(row, client, recipient);
    this.logger.log(
      `Human reply ${row.id} to ${maskPhone(recipient)}: ${result.outcome}`,
    );
    return result;
  }

  /** Under the row lock: take it when nobody has it; 409 when someone else does. */
  private async takeIfUnassigned(
    tx: Prisma.TransactionClient,
    conversationId: string,
    contextId: string,
    author: SessionUser,
    assignedToId: string | null,
  ): Promise<void> {
    if (assignedToId === author.id) {
      return;
    }
    if (assignedToId) {
      throw new ConflictException({
        message: 'Someone else has this conversation: take it first',
        code: 'ALREADY_TAKEN',
      });
    }
    await tx.conversation.update({
      where: { id: conversationId },
      data: take(author.id),
    });
    await addSystemMessage(tx, {
      conversationId,
      contextId,
      author: 'HUMAN',
      text: `${author.name} tomó la conversación`,
    });
  }

  private async deliver(
    row: Message,
    client: WhatsAppClient,
    waId: string,
  ): Promise<HumanReplyResult> {
    const { count } = await this.prisma.message.updateMany({
      where: { id: row.id, status: MessageStatus.QUEUED },
      data: { status: MessageStatus.SENDING },
    });
    if (count !== 1) {
      throw new ConflictException('Message is already being sent');
    }

    let outcome: SendOutcome;
    try {
      outcome = await client.sendText(waId, row.content);
    } catch {
      // The port should never throw; if it does, the request may have left.
      outcome = { kind: 'uncertain', reason: 'client threw' };
    }

    switch (outcome.kind) {
      case 'sent':
        await this.setStatus(row, MessageStatus.SENT, {
          waMessageId: outcome.waMessageId,
        });
        return {
          outcome: 'sent',
          messageId: row.id,
          waMessageId: outcome.waMessageId,
        };
      case 'uncertain':
        await this.setStatus(row, MessageStatus.UNCERTAIN, {});
        return {
          outcome: 'uncertain',
          messageId: row.id,
          detail: UNCERTAIN_DETAIL,
        };
      case 'rejected': {
        // No automatic retry here: the person decides whether to send again.
        const code = String(outcome.code);
        await this.setStatus(
          row,
          MessageStatus.FAILED,
          { errorCode: code },
          metaErrorKind(outcome.code) === 'window_closed',
        );
        return {
          outcome: 'rejected',
          messageId: row.id,
          code,
          retryable: outcome.retryable,
          detail: outcome.message,
        };
      }
    }
  }

  private findByKey(idempotencyKey: string) {
    return this.prisma.message.findUnique({ where: { idempotencyKey } });
  }

  /**
   * The send's result, and the conversation joins the inbox changes. Meta
   * saying the window is closed moves windowExpiresAt to now.
   */
  private async setStatus(
    row: Message,
    status: MessageStatus,
    extra: { waMessageId?: string; errorCode?: string },
    windowClosed = false,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.message.update({
        where: { id: row.id },
        data: { status, ...extra },
      });
      if (windowClosed) {
        await tx.conversation.update({
          where: { id: row.conversationId },
          data: { windowExpiresAt: new Date() },
        });
      } else {
        await touchConversations(tx, { id: row.conversationId });
      }
    });
  }
}

function replayed(message: Message, conversationId: string): HumanReplyResult {
  if (message.conversationId !== conversationId) {
    throw new ConflictException(
      'Idempotency key already used for another conversation',
    );
  }
  return {
    outcome: 'replayed',
    messageId: message.id,
    status: message.status,
    waMessageId: message.waMessageId,
  };
}
