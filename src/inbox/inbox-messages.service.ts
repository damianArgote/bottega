import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { BusinessAccess } from '../auth/business-access.guard.js';
import type { SessionUser } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  renderTemplate,
  TemplateValuesError,
  unsupportedReason,
} from '../templates/template-render.js';
import { TemplatesService } from '../templates/templates.service.js';
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
    private readonly templates: TemplatesService,
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
    const conversation = await this.conversation(access, conversationId);
    return this.replies.send({
      conversation,
      text: input.body,
      idempotencyKey: `inbox:${input.clientId}`,
      author: user,
    });
  }

  /**
   * POST /conversations/:id/templates: an approved template of the line's
   * account with its values, sent even with the window closed (same
   * at-most-once rule per clientId as a reply). 404 unknown template; 409
   * `TEMPLATE_NOT_APPROVED`, `TEMPLATE_OTHER_ACCOUNT` or
   * `TEMPLATE_UNSUPPORTED`; 400 `TEMPLATE_VALUES` when a value is missing
   * or invalid. Nothing reaches Meta in those cases.
   */
  async sendTemplate(
    access: BusinessAccess,
    user: SessionUser,
    conversationId: string,
    input: { templateId: string; values: string[]; clientId: string },
  ): Promise<HumanReplyResult> {
    const conversation = await this.conversation(access, conversationId);
    const idempotencyKey = `inbox:${input.clientId}`;
    const previous = await this.replies.replayOf(
      idempotencyKey,
      conversation.id,
    );
    if (previous) {
      return previous;
    }
    const template = await this.templates.find(
      access.businessId,
      input.templateId,
    );
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    if (template.deletedAt || template.status !== 'APPROVED') {
      throw new ConflictException({
        message: `Template is not approved (status ${template.deletedAt ? 'DELETED' : template.status})`,
        code: 'TEMPLATE_NOT_APPROVED',
      });
    }
    if (template.wabaId !== conversation.line.wabaId) {
      throw new ConflictException({
        message:
          "Template belongs to another WhatsApp Business account than the conversation's line",
        code: 'TEMPLATE_OTHER_ACCOUNT',
      });
    }
    const unsupported = unsupportedReason(
      template.category,
      template.components,
    );
    if (unsupported) {
      throw new ConflictException({
        message: `Template cannot be sent from the inbox: ${unsupported}`,
        code: 'TEMPLATE_UNSUPPORTED',
      });
    }
    let rendered;
    try {
      rendered = renderTemplate(template, input.values);
    } catch (error) {
      if (!(error instanceof TemplateValuesError)) {
        throw error;
      }
      throw new BadRequestException({
        message: error.message,
        code: 'TEMPLATE_VALUES',
        missing: error.missing,
      });
    }
    return this.replies.send({
      conversation,
      text: rendered.text,
      idempotencyKey,
      author: user,
      template: { message: rendered.message, buttons: rendered.buttons },
    });
  }

  private async conversation(access: BusinessAccess, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, line: { businessId: access.businessId } },
      select: {
        id: true,
        lineId: true,
        activeContextId: true,
        windowExpiresAt: true,
        lastInboundAt: true,
        contact: { select: { waId: true } },
        line: { select: { wabaId: true } },
      },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
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
