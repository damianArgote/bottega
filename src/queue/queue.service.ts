import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation, millis, UTC_NOW } from '../prisma/sql.js';

interface ClaimedJobBase {
  id: string;
  conversationId: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
  createdAt: Date;
}

/** A job owned by a worker until it completes, fails, or its lease expires. */
export type ClaimedJob =
  | (ClaimedJobBase & {
      type: 'INBOUND_MESSAGE';
      messageId: string;
      pushReason: null;
    })
  | (ClaimedJobBase & {
      type: 'PUSH_NOTIFICATION';
      /** Null for a handoff. */
      messageId: string | null;
      pushReason: 'INBOUND' | 'HANDOFF';
    });

/** The bot's job: answers an inbound message. */
export type InboundJob = Extract<ClaimedJob, { type: 'INBOUND_MESSAGE' }>;
export type PushJob = Extract<ClaimedJob, { type: 'PUSH_NOTIFICATION' }>;

export interface FailOptions {
  retryable: boolean;
}

export type FailOutcome = 'retry_scheduled' | 'failed' | 'lost_lease';

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_ERROR_LENGTH = 120;

/**
 * PostgreSQL-backed job queue.
 *
 * Guarantees:
 * - A job is owned by at most one worker at a time (row lock + lease).
 * - The bot's jobs (INBOUND_MESSAGE) of one conversation run one at a time
 *   and in enqueue order (`seq`): only the oldest unfinished one of a
 *   conversation is claimable, and the partial unique index
 *   `(conversation_id) WHERE status = 'PROCESSING' AND type =
 *   'INBOUND_MESSAGE'` is the last line of defense.
 * - PUSH_NOTIFICATION jobs run outside that order: they neither wait for
 *   the bot's jobs nor hold them back (a push retrying must not delay a
 *   reply).
 * - A crashed worker's job is reclaimed once its lease expires.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Claims the next runnable job, or returns null when there is none. */
  async claimNext(workerId: string): Promise<ClaimedJob | null> {
    const leaseMs = this.config.get('QUEUE_LEASE_MS');
    try {
      const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
        WITH candidate AS (
          SELECT j.id
          FROM processing_job j
          WHERE ((j.status = 'PENDING' AND j.run_after <= ${UTC_NOW})
              OR (j.status = 'PROCESSING' AND j.lease_expires_at < ${UTC_NOW}))
            AND (j.type = 'PUSH_NOTIFICATION' OR NOT EXISTS (
              SELECT 1 FROM processing_job older
              WHERE older.conversation_id = j.conversation_id
                AND older.type = 'INBOUND_MESSAGE'
                AND older.status IN ('PENDING', 'PROCESSING')
                AND older.seq < j.seq
            ))
          ORDER BY j.seq
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE processing_job j
        SET status = 'PROCESSING',
            lease_expires_at = ${UTC_NOW} + ${millis(leaseMs)},
            locked_by = ${workerId},
            attempts = j.attempts + 1,
            updated_at = ${UTC_NOW}
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.id, j.type::text AS type,
          j.conversation_id AS "conversationId", j.message_id AS "messageId",
          j.push_reason::text AS "pushReason", j.attempts,
          j.max_attempts AS "maxAttempts", j.locked_by AS "lockedBy",
          j.created_at AS "createdAt"`;
      return rows[0] ?? null;
    } catch (error) {
      // Another worker already holds a PROCESSING job of this conversation
      // (stale snapshot race): nothing claimable right now.
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Marks the job done. Returns false when the worker no longer owns it. */
  async complete(job: Pick<ClaimedJob, 'id' | 'lockedBy'>): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE processing_job
      SET status = 'COMPLETED', lease_expires_at = NULL, locked_by = NULL,
          updated_at = ${UTC_NOW}
      WHERE id = ${job.id}::uuid AND status = 'PROCESSING'
        AND locked_by = ${job.lockedBy}`;
    return count > 0;
  }

  /**
   * Marks the job done without a reply (a person attends the conversation).
   * Returns false when the worker no longer owns it.
   */
  async skip(job: Pick<ClaimedJob, 'id' | 'lockedBy'>): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE processing_job
      SET status = 'SKIPPED', lease_expires_at = NULL, locked_by = NULL,
          updated_at = ${UTC_NOW}
      WHERE id = ${job.id}::uuid AND status = 'PROCESSING'
        AND locked_by = ${job.lockedBy}`;
    return count > 0;
  }

  /**
   * Records a failure. Retryable failures with attempts left go back to
   * PENDING with exponential backoff (5s·2^attempts, capped at 5 min);
   * anything else ends FAILED, which no longer blocks the conversation.
   */
  async fail(
    job: Pick<ClaimedJob, 'id' | 'lockedBy'>,
    error: unknown,
    { retryable }: FailOptions,
  ): Promise<FailOutcome> {
    const lastError = sanitizeError(error);
    const rows = await this.prisma.$queryRaw<Array<{ status: string }>>`
      UPDATE processing_job
      SET status = CASE WHEN ${retryable} AND attempts < max_attempts
                     THEN 'PENDING'::job_status ELSE 'FAILED'::job_status END,
          run_after = CASE WHEN ${retryable} AND attempts < max_attempts
                     THEN ${UTC_NOW} + LEAST(${BASE_BACKOFF_MS}::double precision
                       * power(2, attempts), ${MAX_BACKOFF_MS}::double precision)
                       * interval '1 millisecond'
                     ELSE run_after END,
          lease_expires_at = NULL,
          locked_by = NULL,
          last_error = ${lastError},
          updated_at = ${UTC_NOW}
      WHERE id = ${job.id}::uuid AND status = 'PROCESSING'
        AND locked_by = ${job.lockedBy}
      RETURNING status::text AS status`;
    const status = rows[0]?.status;
    if (!status) {
      this.logger.warn(`Job ${job.id} failure not recorded: lease lost`);
      return 'lost_lease';
    }
    return status === 'PENDING' ? 'retry_scheduled' : 'failed';
  }

  /**
   * Earliest moment an unfinished job becomes claimable: the `run_after` of
   * a pending job or the lease expiry of a running one. Null when no job is
   * pending or running. Used by an idle worker to decide when to poll.
   */
  async nextRunnableAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT min(CASE WHEN status = 'PENDING' THEN run_after
                      ELSE lease_expires_at END) AS at
      FROM processing_job
      WHERE status IN ('PENDING', 'PROCESSING')`;
    return rows[0]?.at ?? null;
  }

  /** Pushes the lease forward for long jobs. Returns false if ownership was lost. */
  async extendLease(
    job: Pick<ClaimedJob, 'id' | 'lockedBy'>,
  ): Promise<boolean> {
    const leaseMs = this.config.get('QUEUE_LEASE_MS');
    const count = await this.prisma.$executeRaw`
      UPDATE processing_job
      SET lease_expires_at = ${UTC_NOW} + ${millis(leaseMs)},
          updated_at = ${UTC_NOW}
      WHERE id = ${job.id}::uuid AND status = 'PROCESSING'
        AND locked_by = ${job.lockedBy}`;
    return count > 0;
  }
}

/**
 * Short, content-free error label for `last_error`: error name plus an
 * optional code. Never the message (it may contain user text or tokens).
 */
export function sanitizeError(error: unknown): string {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === 'string'
        ? error
        : '';
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number'
      ? String(rawCode)
      : '';
  const label = [name || 'UnknownError', code].filter(Boolean).join(':');
  return label.replace(/[^\w.:-]/g, '_').slice(0, MAX_ERROR_LENGTH);
}
