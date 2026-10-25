import {
  type HumanReplyResult,
  HumanRepliesService,
  windowOpen,
} from '../inbox/human-replies.service.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ContextService } from '../conversations/context.service.js';
import {
  type Conversation,
  type HandoffStatus,
  type LeadStatus,
  MessageDirection,
} from '../generated/prisma/client.js';
import { DEFAULT_BUSINESS_SLUG } from '../lines/default-line.seed.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  WHATSAPP_CLIENT_FACTORY,
  type WhatsAppClientFactory,
} from '../whatsapp/whatsapp.client.js';
import { ATTENTION_STATUSES } from './admin.schemas.js';

/** WhatsApp customer service window: free-form replies only inside it. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HANDOFF_REASON_ADMIN = 'admin';
const IDEMPOTENCY_PREFIX = 'admin:';

const conversationSummary = {
  select: {
    id: true,
    mode: true,
    paused: true,
    contact: { select: { waId: true } },
  },
} as const;

type ConversationSummaryRow = {
  id: string;
  mode: Conversation['mode'];
  paused: boolean;
  contact: { waId: string };
};

/**
 * The admin API's conversation summary: `{ id, waId, mode, paused }`, with
 * the wa_id taken from the contact (the conversation no longer stores it).
 */
function withSummary<T extends { conversation: ConversationSummaryRow }>(
  row: T,
) {
  const { id, mode, paused, contact } = row.conversation;
  return {
    ...row,
    conversation: { id, waId: contact.waId, mode, paused },
  };
}

type ConversationWithContact = Conversation & { contact: { waId: string } };

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

/** The 24 h window as the admin API shows it (from windowExpiresAt). */
export function serviceWindow(
  windowExpiresAt: Date | null,
  now = new Date(),
): ServiceWindow {
  return {
    open: windowOpen(windowExpiresAt, now),
    closesAt: windowExpiresAt,
  };
}

/** Read and operate conversations for the team (admin API). */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contexts: ContextService,
    @Inject(WHATSAPP_CLIENT_FACTORY)
    private readonly clients: WhatsAppClientFactory,
  ) {
    this.replies = new HumanRepliesService(prisma, clients);
  }

  /** Shared with the inbox: same send rules and idempotency. */
  private readonly replies: HumanRepliesService;

  async listLeads(query: { status?: LeadStatus; limit: number }) {
    const rows = await this.prisma.lead.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { conversation: conversationSummary },
    });
    return rows.map(withSummary);
  }

  async listHandoffs(query: { status?: HandoffStatus; limit: number }) {
    const rows = await this.prisma.handoffRequest.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { conversation: conversationSummary },
    });
    return rows.map(withSummary);
  }

  /** Outbound sends that ended UNCERTAIN or FAILED, newest first. */
  async listAttentionMessages(query: {
    status?: (typeof ATTENTION_STATUSES)[number];
    limit: number;
  }) {
    const rows = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.OUTBOUND,
        status: query.status ?? { in: [...ATTENTION_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: { ...messageView, conversation: conversationSummary },
    });
    return rows.map(withSummary);
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
   * Sends a human-written text now, inside the 24h service window only
   * (HumanRepliesService: at most once, never retried when uncertain). The
   * admin API acts without a user, so it does not take the conversation and
   * does not change the pause state.
   */
  async sendHumanReply(
    id: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<HumanReplyResult> {
    const conversation = await this.findConversation({ id });
    return this.replies.send({
      conversation,
      text,
      idempotencyKey: `${IDEMPOTENCY_PREFIX}${idempotencyKey ?? randomUUID()}`,
    });
  }

  private async describe(conversation: ConversationWithContact, limit: number) {
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
        waId: conversation.contact.waId,
        mode: conversation.mode,
        paused: conversation.paused,
        pausedAt: conversation.pausedAt,
        activeContextId: conversation.activeContextId,
        lastInboundAt: conversation.lastInboundAt,
        createdAt: conversation.createdAt,
      },
      serviceWindow: serviceWindow(conversation.windowExpiresAt),
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
  ): Promise<ConversationWithContact> {
    const include = { contact: { select: { waId: true } } } as const;
    const conversation =
      'id' in where
        ? await this.prisma.conversation.findUnique({ where, include })
        : await this.prisma.conversation.findFirst({
            where: {
              contact: { waId: where.waId },
              line: { business: { slug: DEFAULT_BUSINESS_SLUG } },
            },
            orderBy: { createdAt: 'asc' },
            include,
          });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }
}
