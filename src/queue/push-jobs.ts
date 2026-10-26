import type { Prisma, PushReason } from '../generated/prisma/client.js';
import { UTC_NOW } from '../prisma/sql.js';
import type { PushJob } from './queue.service.js';

export interface PushJobInput {
  conversationId: string;
  reason: PushReason;
  /** The inbound message it shows; null for a handoff. */
  messageId: string | null;
  maxAttempts: number;
}

/**
 * Enqueues a PUSH_NOTIFICATION job, in the caller's transaction. Its
 * recipients are decided when it runs. Push jobs run outside the
 * conversation's order (see QueueService.claimNext). Returns its id.
 */
export async function enqueuePushJob(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: PushJobInput,
): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO processing_job
      (id, type, conversation_id, push_message_id, push_reason, status,
       attempts, max_attempts, run_after, created_at, updated_at)
    VALUES (gen_random_uuid(), 'PUSH_NOTIFICATION', ${input.conversationId}::uuid,
      ${input.messageId}::uuid, ${input.reason}::push_reason, 'PENDING', 0,
      ${input.maxAttempts}, ${UTC_NOW}, ${UTC_NOW}, ${UTC_NOW})
    RETURNING id`;
  return row!.id;
}

/** Runs PUSH_NOTIFICATION jobs (PushModule); 'skipped': nothing to send. */
export interface PushJobProcessor {
  process(job: PushJob): Promise<'done' | 'skipped'>;
}

export const PUSH_JOB_PROCESSOR = Symbol('PUSH_JOB_PROCESSOR');
