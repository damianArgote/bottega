import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BusinessAccess } from '../auth/business-access.guard.js';
import type { SessionUser } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  WHATSAPP_CLIENT_FACTORY,
  type WhatsAppClientFactory,
} from '../whatsapp/whatsapp.client.js';
import {
  type HumanReplyResult,
  HumanRepliesService,
} from './human-replies.service.js';

/** Writing and reading messages from the inbox. */
@Injectable()
export class InboxMessagesService {
  private readonly logger = new Logger(InboxMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly replies: HumanRepliesService,
    @Inject(WHATSAPP_CLIENT_FACTORY)
    private readonly clients: WhatsAppClientFactory,
  ) {}

  /**
   * POST /conversations/:id/messages: a person's reply (HumanRepliesService:
   * window checked before Meta, at most once per clientId, takes an
   * unassigned conversation).
   */
  async reply(
    access: BusinessAccess,
    user: SessionUser,
    conversationId: string,
    input: { body: string; clientId: string },
  ): Promise<HumanReplyResult> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, line: { businessId: access.businessId } },
      select: {
        id: true,
        lineId: true,
        activeContextId: true,
        windowExpiresAt: true,
        lastInboundAt: true,
        contact: { select: { waId: true } },
      },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return this.replies.send({
      conversation,
      text: input.body,
      idempotencyKey: `inbox:${input.clientId}`,
      author: user,
    });
  }

  /**
   * POST /conversations/:id/read: no unread messages left, and the last
   * inbound message marked read in WhatsApp (best effort: a failure there
   * is logged and ignored).
   */
  async read(access: BusinessAccess, conversationId: string) {
    const { count } = await this.prisma.conversation.updateMany({
      where: { id: conversationId, line: { businessId: access.businessId } },
      data: { unreadCount: 0 },
    });
    if (count === 0) {
      throw new NotFoundException('Conversation not found');
    }
    const last = await this.prisma.message.findFirst({
      where: {
        conversationId,
        direction: 'INBOUND',
        waMessageId: { not: null },
      },
      orderBy: { seq: 'desc' },
      select: { waMessageId: true, conversation: { select: { lineId: true } } },
    });
    if (last?.waMessageId) {
      try {
        const client = await this.clients.forLine(last.conversation.lineId);
        await client.markRead?.(last.waMessageId);
      } catch {
        this.logger.warn(
          `Mark as read failed for conversation ${conversationId}: ignored`,
        );
      }
    }
    return { unreadCount: 0 };
  }
}
