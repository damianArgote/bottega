import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContextService } from '../conversations/context.service.js';
import {
  type Conversation,
  type HandoffStatus,
  type LeadStatus,
  type Message,
  MessageAuthor,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../generated/prisma/client.js';
import { DEFAULT_BUSINESS_SLUG } from '../lines/default-line.seed.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../prisma/sql.js';
import {
  maskPhone,
  WHATSAPP_CLIENT,
  type SendOutcome,
  type WhatsAppClient,
} from '../whatsapp/whatsapp.client.js';
import { ATTENTION_STATUSES } from './admin.schemas.js';

/** WhatsApp customer service window: free-form replies only inside it. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HANDOFF_REASON_ADMIN = 'admin';
const IDEMPOTENCY_PREFIX = 'admin:';

const conversationSummary = {
  select: { id: true, waId: true, mode: true, paused: true },
} as const;

const messageView = {
  id: true,
  conversationId: true,
  contextId: true,
  direction: true,
  author: true,
  type: true,
  status: true,
  content: true,
  waMessageId: true,
  errorCode: true,
  createdAt: true,
} as const;

export interface ServiceWindow {
  open: boolean;
  /** When the window closes (or closed); null when the user never wrote. */
  closesAt: Date | null;
}

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
      /** Same Idempotency-Key as an earlier request: nothing was sent now. */
      outcome: 'replayed';
      messageId: string;
      status: MessageStatus;
      waMessageId: string | null;
    };

const UNCERTAIN_DETAIL =
  'Meta may or may not have accepted the message. It is NOT resent automatically: check the chat on the phone before sending it again.';

export function serviceWindow(
  lastInboundAt: Date | null,
  now = new Date(),
): ServiceWindow {
  if (!lastInboundAt) {
    return { open: false, closesAt: null };
  }
  const closesAt = new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);
  return { open: closesAt.getTime() > now.getTime(), closesAt };
}

/** Read and operate conversations for the team (admin API). */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contexts: ContextService,
    @Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClient,
  ) {}

  listLeads(query: { status?: LeadStatus; limit: number }) {
    return this.prisma.lead.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { conversation: conversationSummary },
    });
  }

  listHandoffs(query: { status?: HandoffStatus; limit: number }) {
    return this.prisma.handoffRequest.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { conversation: conversationSummary },
    });
  }

  /** Outbound sends that ended UNCERTAIN or FAILED, newest first. */
  listAttentionMessages(query: {
    status?: (typeof ATTENTION_STATUSES)[number];
    limit: number;
  }) {
    return this.prisma.message.findMany({
      where: {
        direction: MessageDirection.OUTBOUND,
        status: query.status ?? { in: [...ATTENTION_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: { ...messageView, conversation: conversationSummary },
    });
  }

  async getConversation(id: string, limit: number) {
    return this.describe(await this.findConversation({ id }), limit);
  }

  async getConversationByWaId(waId: string, limit: number) {
    return this.describe(await this.findConversation({ waId }), limit);
  }

  async pause(id: string) {
    await this.findConversation({ id });
    const result = await this.contexts.pause(id, HANDOFF_REASON_ADMIN);
    this.logger.log(
      `Conversation ${id} paused by admin (already paused: ${result.wasPaused}, handoff created: ${result.handoffCreated})`,
    );
    return { conversationId: id, paused: true, ...result };
  }

  async resume(id: string, resolveHandoffs: boolean) {
    await this.findConversation({ id });
    const result = await this.contexts.resume(id, resolveHandoffs);
    this.logger.log(
      `Conversation ${id} resumed by admin (was paused: ${result.wasPaused}, handoffs resolved: ${result.resolvedHandoffs})`,
    );
    return { conversationId: id, paused: false, ...result };
  }

  /**
   * Sends a human-written text now, inside the 24h service window only.
   * Same at-most-once rules as the worker: QUEUED → SENDING → SENT /
   * FAILED / UNCERTAIN, and an uncertain send is never retried. Does not
   * change the pause state.
   */
  async sendHumanReply(
    id: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<HumanReplyResult> {
    const conversation = await this.findConversation({ id });
    const key = `${IDEMPOTENCY_PREFIX}${idempotencyKey ?? randomUUID()}`;

    const previous = idempotencyKey ? await this.findByKey(key) : null;
    if (previous) {
      return replayed(previous, id);
    }

    const window = serviceWindow(conversation.lastInboundAt);
    if (!window.open) {
      throw new ConflictException(
        'The 24h customer service window is closed (the user has not written in the last 24 hours). WhatsApp only allows approved message templates outside the window, and this API does not send templates. Wait until the user writes again.',
      );
    }
    if (!conversation.activeContextId) {
      throw new ConflictException('Conversation has no active context');
    }

    let row: Message;
    try {
      row = await this.prisma.message.create({
        data: {
          conversationId: id,
          contextId: conversation.activeContextId,
          direction: MessageDirection.OUTBOUND,
          type: MessageType.TEXT,
          content: text,
          status: MessageStatus.QUEUED,
          author: MessageAuthor.HUMAN,
          idempotencyKey: key,
        },
      });
    } catch (error) {
      // A concurrent request with the same Idempotency-Key won the insert.
      const existing = isUniqueViolation(error)
        ? await this.findByKey(key)
        : null;
      if (existing) {
        return replayed(existing, id);
      }
      throw error;
    }

    const result = await this.deliver(row, conversation.waId);
    this.logger.log(
      `Human reply ${row.id} to ${maskPhone(conversation.waId)}: ${result.outcome}`,
    );
    return result;
  }

  private async deliver(row: Message, waId: string): Promise<HumanReplyResult> {
    const { count } = await this.prisma.message.updateMany({
      where: { id: row.id, status: MessageStatus.QUEUED },
      data: { status: MessageStatus.SENDING },
    });
    if (count !== 1) {
      throw new ConflictException('Message is already being sent');
    }

    let outcome: SendOutcome;
    try {
      outcome = await this.client.sendText(waId, row.content);
    } catch {
      // The port should never throw; if it does, the request may have left.
      outcome = { kind: 'uncertain', reason: 'client threw' };
    }

    switch (outcome.kind) {
      case 'sent':
        await this.setStatus(row.id, MessageStatus.SENT, {
          waMessageId: outcome.waMessageId,
        });
        return {
          outcome: 'sent',
          messageId: row.id,
          waMessageId: outcome.waMessageId,
        };
      case 'uncertain':
        await this.setStatus(row.id, MessageStatus.UNCERTAIN, {});
        return {
          outcome: 'uncertain',
          messageId: row.id,
          detail: UNCERTAIN_DETAIL,
        };
      case 'rejected': {
        // No automatic retry here: the caller decides whether to send again.
        const code = String(outcome.code);
        await this.setStatus(row.id, MessageStatus.FAILED, { errorCode: code });
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

  private async describe(conversation: Conversation, limit: number) {
    const [lead, openHandoffs, latest] = await Promise.all([
      this.prisma.lead.findUnique({
        where: { conversationId: conversation.id },
      }),
      this.prisma.handoffRequest.findMany({
        where: { conversationId: conversation.id, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: messageView,
      }),
    ]);
    return {
      conversation: {
        id: conversation.id,
        waId: conversation.waId,
        mode: conversation.mode,
        paused: conversation.paused,
        pausedAt: conversation.pausedAt,
        activeContextId: conversation.activeContextId,
        lastInboundAt: conversation.lastInboundAt,
        createdAt: conversation.createdAt,
      },
      serviceWindow: serviceWindow(conversation.lastInboundAt),
      lead,
      openHandoffs,
      // Oldest first, like reading the chat.
      messages: latest.reverse(),
    };
  }

  /**
   * By id, or by wa_id within the default business (the admin API predates
   * multiple businesses; a wa_id is only unique per line).
   */
  private async findConversation(
    where: { id: string } | { waId: string },
  ): Promise<Conversation> {
    const conversation =
      'id' in where
        ? await this.prisma.conversation.findUnique({ where })
        : await this.prisma.conversation.findFirst({
            where: {
              waId: where.waId,
              line: { business: { slug: DEFAULT_BUSINESS_SLUG } },
            },
            orderBy: { createdAt: 'asc' },
          });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }

  private findByKey(idempotencyKey: string) {
    return this.prisma.message.findUnique({ where: { idempotencyKey } });
  }

  private async setStatus(
    id: string,
    status: MessageStatus,
    extra: { waMessageId?: string; errorCode?: string },
  ): Promise<void> {
    await this.prisma.message.update({
      where: { id },
      data: { status, ...extra },
    });
  }
}

function replayed(message: Message, conversationId: string): HumanReplyResult {
  if (message.conversationId !== conversationId) {
    throw new ConflictException(
      'Idempotency-Key already used for another conversation',
    );
  }
  return {
    outcome: 'replayed',
    messageId: message.id,
    status: message.status,
    waMessageId: message.waMessageId,
  };
}
