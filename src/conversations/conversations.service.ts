import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { MessageStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UTC_NOW } from '../prisma/sql.js';
import type {
  InboundEvent,
  InboundText,
  InboundUnsupported,
  StatusUpdate,
} from '../whatsapp/inbound-event.js';
import { maskPhone } from '../whatsapp/whatsapp.client.js';

export type RecordInboundResult =
  | { outcome: 'created'; conversationId: string; messageId: string }
  | { outcome: 'duplicate'; conversationId: string };

export type ApplyStatusResult = 'updated' | 'ignored';

/** Meta status → our outbound status. Other values are ignored. */
const STATUS_MAP: Record<string, MessageStatus> = {
  sent: MessageStatus.SENT,
  delivered: MessageStatus.DELIVERED,
  read: MessageStatus.READ,
  failed: MessageStatus.FAILED,
};

/**
 * Statuses a message may be in for each target status. Statuses only move
 * forward (SENT → DELIVERED → READ); FAILED is accepted from any non-final
 * state. Webhooks arrive out of order, so a late "delivered" after "read"
 * must not regress the message.
 */
const ALLOWED_PREVIOUS: Record<string, MessageStatus[]> = {
  // The worker itself records SENT together with the wamid, so a "sent"
  // webhook never changes anything; it is accepted for completeness.
  [MessageStatus.SENT]: [],
  [MessageStatus.DELIVERED]: [MessageStatus.SENT],
  [MessageStatus.READ]: [MessageStatus.SENT, MessageStatus.DELIVERED],
  [MessageStatus.FAILED]: [
    MessageStatus.QUEUED,
    MessageStatus.SENDING,
    MessageStatus.UNCERTAIN,
    MessageStatus.SENT,
    MessageStatus.DELIVERED,
  ],
};

/**
 * Persistence of WhatsApp traffic: conversations, inbound messages (with
 * their processing job) and outbound status updates.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Persists every parsed webhook event, in order. Throws when the database
   * fails, so the webhook answers 5xx and Meta redelivers (dedupe makes
   * redelivery safe).
   */
  async ingest(events: readonly InboundEvent[]): Promise<void> {
    for (const event of events) {
      switch (event.kind) {
        case 'ignored':
          this.logger.debug(`Ignored webhook item: ${event.reason}`);
          break;
        case 'status':
          await this.applyStatus(event);
          break;
        case 'text':
        case 'unsupported':
          await this.recordInbound(event);
          break;
      }
    }
  }

  /**
   * Stores an inbound message and enqueues its processing job in a single
   * transaction. A message id seen before is a no-op (no message, no job),
   * also under concurrent duplicate deliveries: the insert uses
   * `ON CONFLICT (wa_message_id) DO NOTHING`.
   */
  async recordInbound(
    event: InboundText | InboundUnsupported,
  ): Promise<RecordInboundResult> {
    const maxAttempts = this.config.get('JOB_MAX_ATTEMPTS');
    const type = event.kind === 'text' ? 'TEXT' : 'UNSUPPORTED';
    const content =
      event.kind === 'text' ? event.text : `[${event.messageType}]`;

    const result = await this.prisma.$transaction(async (tx) => {
      // Upsert locks the conversation row until commit, which serializes
      // concurrent inbound transactions of the same conversation.
      const [conversation] = await tx.$queryRaw<
        Array<{ id: string; activeContextId: string | null }>
      >`
        INSERT INTO conversation
          (id, wa_id, mode, paused, last_inbound_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${event.from}, 'COMMERCIAL', false,
          ${event.timestamp.toISOString()}::timestamp, ${UTC_NOW}, ${UTC_NOW})
        ON CONFLICT (wa_id) DO UPDATE SET
          last_inbound_at = GREATEST(conversation.last_inbound_at, EXCLUDED.last_inbound_at),
          updated_at = EXCLUDED.updated_at
        RETURNING id, active_context_id AS "activeContextId"`;
      if (!conversation) {
        throw new Error('conversation upsert returned no row');
      }

      let contextId = conversation.activeContextId;
      if (!contextId) {
        const context = await tx.conversationContext.create({
          data: { conversationId: conversation.id, mode: 'COMMERCIAL' },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { activeContextId: context.id },
        });
        contextId = context.id;
      }

      const [message] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO message
          (id, conversation_id, context_id, wa_message_id, direction, type,
           content, status, author, created_at, updated_at)
        VALUES (gen_random_uuid(), ${conversation.id}::uuid, ${contextId}::uuid,
          ${event.waMessageId}, 'INBOUND', ${type}::message_type, ${content},
          'RECEIVED', 'USER', ${UTC_NOW}, ${UTC_NOW})
        ON CONFLICT (wa_message_id) DO NOTHING
        RETURNING id`;
      if (!message) {
        return {
          outcome: 'duplicate',
          conversationId: conversation.id,
        } as const;
      }

      await tx.$executeRaw`
        INSERT INTO processing_job
          (id, type, conversation_id, message_id, status, attempts,
           max_attempts, run_after, created_at, updated_at)
        VALUES (gen_random_uuid(), 'INBOUND_MESSAGE', ${conversation.id}::uuid,
          ${message.id}::uuid, 'PENDING', 0, ${maxAttempts}, ${UTC_NOW},
          ${UTC_NOW}, ${UTC_NOW})`;

      return {
        outcome: 'created',
        conversationId: conversation.id,
        messageId: message.id,
      } as const;
    });

    this.logger.log(
      result.outcome === 'created'
        ? `Inbound ${type} message ${result.messageId} from ${maskPhone(event.from)} queued`
        : `Duplicate delivery skipped for message from ${maskPhone(event.from)}`,
    );
    return result;
  }

  /**
   * Applies a delivery status to the outbound message with that WhatsApp id.
   * Unknown ids, unknown statuses and backward moves are ignored. Never
   * creates jobs.
   */
  async applyStatus(update: StatusUpdate): Promise<ApplyStatusResult> {
    const target = STATUS_MAP[update.status];
    if (!target) {
      this.logger.debug(`Ignored unknown status value for an outbound message`);
      return 'ignored';
    }
    const errorCode =
      target === MessageStatus.FAILED && update.errors?.[0]
        ? String(update.errors[0].code)
        : undefined;

    const { count } = await this.prisma.message.updateMany({
      where: {
        waMessageId: update.waMessageId,
        direction: 'OUTBOUND',
        status: { in: ALLOWED_PREVIOUS[target] ?? [] },
      },
      data: { status: target, ...(errorCode ? { errorCode } : {}) },
    });

    this.logger.debug(
      `Status ${target} for message to ${maskPhone(update.recipientId)}: ${
        count > 0 ? 'applied' : 'ignored'
      }${errorCode ? ` (error code ${errorCode})` : ''}`,
    );
    return count > 0 ? 'updated' : 'ignored';
  }
}
