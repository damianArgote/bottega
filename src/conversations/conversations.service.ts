import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { MessageStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UTC_NOW } from '../prisma/sql.js';
import { QueueSignal } from '../queue/queue-signal.js';
import type {
  InboundEvent,
  InboundText,
  InboundUnsupported,
  StatusUpdate,
} from '../whatsapp/inbound-event.js';
import { maskPhone } from '../whatsapp/whatsapp.client.js';

export type RecordInboundResult =
  | { outcome: 'created'; conversationId: string; messageId: string }
  | { outcome: 'duplicate'; conversationId: string }
  /** No line to attach the message to: nothing was stored. */
  | { outcome: 'unrouted' };

/** The line an inbound message arrived on, and the business that owns it. */
export interface LineRef {
  lineId: string;
  businessId: string;
}

/** A line with the phone number id its events must carry. */
export interface RoutedLine extends LineRef {
  phoneNumberId: string;
}

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
    private readonly queueSignal: QueueSignal,
  ) {}

  /**
   * Persists every parsed webhook event, in order, on `line` (the default
   * line when omitted). With a line, events of any other phone_number_id are
   * discarded with a warning. Throws when the database fails, so the stored
   * webhook event stays pending for the reprocessor (dedupe makes
   * reprocessing safe).
   */
  async ingest(
    events: readonly InboundEvent[],
    line?: RoutedLine,
  ): Promise<void> {
    for (const event of events) {
      if (event.kind === 'ignored') {
        this.logger.debug(`Ignored webhook item: ${event.reason}`);
        continue;
      }
      if (line && event.phoneNumberId !== line.phoneNumberId) {
        await this.warnOffRoute(event.phoneNumberId);
        continue;
      }
      if (event.kind === 'status') {
        await this.applyStatus(event, line);
      } else {
        await this.recordInbound(event, line);
      }
    }
  }

  /**
   * An event whose phone_number_id is not the line of the route it came
   * through: either another line's (signed by the wrong app) or unknown.
   * Discarded; nothing is created.
   */
  private async warnOffRoute(phoneNumberId: string): Promise<void> {
    const known = await this.prisma.line.findUnique({
      where: { phoneNumberId },
      select: { id: true },
    });
    this.logger.warn(
      known
        ? `Discarded webhook event for line ${known.id}: it arrived through another line's route`
        : 'Discarded webhook event for an unknown phone_number_id',
    );
  }

  /**
   * Stores an inbound message and enqueues its processing job in a single
   * transaction, on the given line (the default line when omitted). The
   * contact is per business and the conversation per (line, contact): it is
   * reopened, never split. A message id seen before is a no-op (no message,
   * no job), also under concurrent duplicate deliveries: the insert uses
   * `ON CONFLICT (wa_message_id) DO NOTHING`.
   */
  async recordInbound(
    event: InboundText | InboundUnsupported,
    line?: LineRef,
  ): Promise<RecordInboundResult> {
    const target = line ?? (await this.defaultLine());
    if (!target) {
      this.logger.warn(
        `Inbound message from ${maskPhone(event.from)} dropped: no line to route it to`,
      );
      return { outcome: 'unrouted' };
    }
    const maxAttempts = this.config.get('JOB_MAX_ATTEMPTS');
    const type = event.kind === 'text' ? 'TEXT' : 'UNSUPPORTED';
    const content =
      event.kind === 'text' ? event.text : `[${event.messageType}]`;

    const result = await this.prisma.$transaction(async (tx) => {
      // Both upserts lock their row until commit (contact first, then
      // conversation, always in this order), which serializes concurrent
      // inbound transactions of the same conversation.
      const profileName = event.kind === 'text' ? event.profileName : undefined;
      const [contact] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO contact
          (id, business_id, wa_id, profile_name, created_at, updated_at)
        VALUES (gen_random_uuid(), ${target.businessId}::uuid, ${event.from},
          ${profileName ?? null}::text, ${UTC_NOW}, ${UTC_NOW})
        ON CONFLICT (business_id, wa_id) DO UPDATE SET
          profile_name = COALESCE(EXCLUDED.profile_name, contact.profile_name),
          updated_at = EXCLUDED.updated_at
        RETURNING id`;
      if (!contact) {
        throw new Error('contact upsert returned no row');
      }
      const [conversation] = await tx.$queryRaw<
        Array<{ id: string; activeContextId: string | null }>
      >`
        INSERT INTO conversation
          (id, line_id, contact_id, wa_id, mode, paused, last_inbound_at,
           created_at, updated_at)
        VALUES (gen_random_uuid(), ${target.lineId}::uuid, ${contact.id}::uuid,
          ${event.from}, 'COMMERCIAL', false,
          ${event.timestamp.toISOString()}::timestamp, ${UTC_NOW}, ${UTC_NOW})
        ON CONFLICT (line_id, contact_id) DO UPDATE SET
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

    if (result.outcome === 'created') {
      // After commit, so the woken worker can already see the job.
      this.queueSignal.notifyEnqueued();
    }
    this.logger.log(
      result.outcome === 'created'
        ? `Inbound ${type} message ${result.messageId} from ${maskPhone(event.from)} queued`
        : `Duplicate delivery skipped for message from ${maskPhone(event.from)}`,
    );
    return result;
  }

  /**
   * The line of WHATSAPP_PHONE_NUMBER_ID (created by `npm run
   * seed:default-line`), or null when it is not configured or not seeded.
   */
  async defaultLine(): Promise<RoutedLine | null> {
    const phoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID');
    if (!phoneNumberId) {
      return null;
    }
    const line = await this.prisma.line.findUnique({
      where: { phoneNumberId },
      select: { id: true, businessId: true },
    });
    return line
      ? { lineId: line.id, businessId: line.businessId, phoneNumberId }
      : null;
  }

  /**
   * Applies a delivery status to the outbound message with that WhatsApp id
   * (on `line` only, when given). Unknown ids, unknown statuses, backward
   * moves and messages of other lines are ignored. Never creates jobs.
   */
  async applyStatus(
    update: StatusUpdate,
    line?: LineRef,
  ): Promise<ApplyStatusResult> {
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
        // A line may only update its own messages, even with a wamid of
        // another line's message.
        ...(line ? { conversation: { lineId: line.lineId } } : {}),
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
