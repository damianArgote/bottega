import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { UTC_NOW } from '../prisma/sql.js';

/** Event types a webhook subscription can receive. */
export const EVENT_TYPES = [
  'lead.updated',
  'handoff.requested',
  'conversation.resolved',
  'payment.approved',
  'payment.expired',
  'payment.review',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Attempts per delivery (the queue's backoff: 5 s·2^n, capped at 5 min). */
export const WEBHOOK_MAX_ATTEMPTS = 6;

type Db = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'conversation' | 'webhookSubscription' | 'webhookDelivery'
>;

/** The JSON body every subscription receives. */
export interface EventEnvelope {
  /** Same for every subscription that receives this event. */
  id: string;
  type: EventType;
  occurredAt: string;
  businessId: string;
  data: Record<string, unknown> & {
    conversation: { id: string; lineId: string };
    contact: { waId: string; name: string | null };
  };
}

/**
 * Enqueues `type` for every active subscription of the conversation's
 * business that wants it: one webhook_delivery and one WEBHOOK_DELIVERY job
 * each, in the caller's transaction, so the event exists only if the change
 * that caused it commits. `data` is the event's own part; the conversation
 * and its contact (wa_id and name, never messages) are added here. Returns
 * how many deliveries were enqueued.
 */
export async function enqueueEvent(
  db: Db,
  input: {
    conversationId: string;
    type: EventType;
    data: Record<string, unknown>;
  },
): Promise<number> {
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: input.conversationId },
    select: {
      id: true,
      lineId: true,
      line: { select: { businessId: true } },
      contact: { select: { waId: true, name: true, profileName: true } },
    },
  });
  const businessId = conversation.line.businessId;
  const subscriptions = await db.webhookSubscription.findMany({
    where: { businessId, active: true, events: { has: input.type } },
    select: { id: true },
  });
  if (subscriptions.length === 0) {
    return 0;
  }
  const envelope: EventEnvelope = {
    id: randomUUID(),
    type: input.type,
    occurredAt: new Date().toISOString(),
    businessId,
    data: {
      ...input.data,
      conversation: { id: conversation.id, lineId: conversation.lineId },
      contact: {
        waId: conversation.contact.waId,
        name: conversation.contact.name ?? conversation.contact.profileName,
      },
    },
  };
  for (const subscription of subscriptions) {
    const delivery = await db.webhookDelivery.create({
      data: {
        subscriptionId: subscription.id,
        eventId: envelope.id,
        event: input.type,
        payload: envelope as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    // Raw insert with UTC_NOW like the push jobs: the claim compares
    // run_after against UTC wall-clock time.
    await db.$queryRaw`
      INSERT INTO processing_job
        (id, type, conversation_id, delivery_id, status, attempts,
         max_attempts, run_after, created_at, updated_at)
      VALUES (gen_random_uuid(), 'WEBHOOK_DELIVERY', ${conversation.id}::uuid,
        ${delivery.id}::uuid, 'PENDING', 0, ${WEBHOOK_MAX_ATTEMPTS},
        ${UTC_NOW}, ${UTC_NOW}, ${UTC_NOW})
      RETURNING id`;
  }
  return subscriptions.length;
}
