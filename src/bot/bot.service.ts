import { Inject, Injectable, Logger } from '@nestjs/common';
import { MessageStatus, type Message } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ClaimedJob } from '../queue/queue.service.js';
import {
  maskPhone,
  WHATSAPP_CLIENT,
  type SendOutcome,
  type WhatsAppClient,
} from '../whatsapp/whatsapp.client.js';
import { REPLY_GENERATOR, type ReplyGenerator } from './reply-generator.js';

/**
 * Failure raised while processing a job. `code` is a short static label
 * (stored as the job's `last_error`); `retryable` decides whether the queue
 * schedules another attempt. Errors of any other type count as retryable.
 */
export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'JobError';
  }
}

export interface ProcessResult {
  outcome: 'paused' | 'done';
  sent: number;
  uncertain: number;
  failed: number;
}

/** Outbound statuses that are never sent (again) by the worker. */
const SETTLED: ReadonlySet<MessageStatus> = new Set([
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
  MessageStatus.READ,
  MessageStatus.FAILED,
  MessageStatus.UNCERTAIN,
]);

/**
 * Processes one inbound-message job in two phases:
 *
 * 1. Generate: build the replies and persist them as QUEUED outbound
 *    messages (idempotency key `${jobId}:${index}`) in the same transaction
 *    that marks the inbound message PROCESSED. That status is the phase
 *    marker: a retried job never calls the generator again.
 * 2. Send: deliver the QUEUED rows in order. Sending is at-most-once: a row
 *    goes QUEUED → SENDING before the API call, and a row still SENDING at
 *    the start of a run (crash mid-send) or with an uncertain outcome is
 *    marked UNCERTAIN and never resent.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClient,
    @Inject(REPLY_GENERATOR) private readonly generator: ReplyGenerator,
  ) {}

  async process(job: ClaimedJob): Promise<ProcessResult> {
    const inbound = await this.prisma.message.findUnique({
      where: { id: job.messageId },
      include: { conversation: true },
    });
    if (!inbound) {
      throw new JobError('inbound_message_missing', false);
    }
    const { conversation } = inbound;
    const to = maskPhone(conversation.waId);

    if (conversation.paused) {
      await this.prisma.message.updateMany({
        where: { id: inbound.id, status: MessageStatus.RECEIVED },
        data: { status: MessageStatus.PROCESSED },
      });
      this.logger.log(`Job ${job.id}: conversation paused, no reply to ${to}`);
      return { outcome: 'paused', sent: 0, uncertain: 0, failed: 0 };
    }

    if (inbound.status === MessageStatus.RECEIVED) {
      await this.generateReplies(job, inbound, conversation.activeContextId);
    }

    const outbound = await this.loadOutbound(job.id);
    const result: ProcessResult = {
      outcome: 'done',
      sent: 0,
      uncertain: 0,
      failed: 0,
    };
    for (const row of outbound) {
      await this.sendRow(job, row, conversation.waId, result);
    }
    this.logger.log(
      `Job ${job.id} for ${to}: sent=${result.sent} uncertain=${result.uncertain} failed=${result.failed}`,
    );
    return result;
  }

  private async generateReplies(
    job: ClaimedJob,
    inbound: Message,
    activeContextId: string | null,
  ): Promise<void> {
    const replies = await this.generator.generate({
      conversationId: inbound.conversationId,
      contextId: activeContextId,
      message: { id: inbound.id, type: inbound.type, content: inbound.content },
    });
    const contextId = activeContextId ?? inbound.contextId;

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.message.updateMany({
        where: { id: inbound.id, status: MessageStatus.RECEIVED },
        data: { status: MessageStatus.PROCESSED },
      });
      if (count !== 1) {
        // Another run persisted this job's replies first: roll back ours.
        throw new JobError('generate_conflict', true);
      }
      if (replies.length > 0) {
        await tx.message.createMany({
          data: replies.map((content, index) => ({
            conversationId: inbound.conversationId,
            contextId,
            direction: 'OUTBOUND' as const,
            type: 'TEXT' as const,
            content,
            status: MessageStatus.QUEUED,
            author: 'BOT' as const,
            idempotencyKey: `${job.id}:${index}`,
          })),
        });
      }
    });
  }

  /** Outbound rows of a job in generation order (by idempotency key index). */
  private async loadOutbound(jobId: string): Promise<Message[]> {
    const rows = await this.prisma.message.findMany({
      where: { idempotencyKey: { startsWith: `${jobId}:` } },
    });
    const index = (row: Message) =>
      Number(row.idempotencyKey?.slice(jobId.length + 1));
    return rows.sort((a, b) => index(a) - index(b));
  }

  private async sendRow(
    job: ClaimedJob,
    row: Message,
    waId: string,
    result: ProcessResult,
  ): Promise<void> {
    if (row.status === MessageStatus.SENDING) {
      // A previous run crashed between claiming the send and recording its
      // outcome: Meta may have accepted it, so never resend.
      await this.setStatus(row.id, MessageStatus.UNCERTAIN, {
        errorCode: 'interrupted_send',
      });
      result.uncertain += 1;
      return;
    }
    if (SETTLED.has(row.status)) {
      return;
    }

    const { count } = await this.prisma.message.updateMany({
      where: { id: row.id, status: MessageStatus.QUEUED },
      data: { status: MessageStatus.SENDING },
    });
    if (count !== 1) {
      throw new JobError('send_conflict', true);
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
        result.sent += 1;
        return;
      case 'uncertain':
        await this.setStatus(row.id, MessageStatus.UNCERTAIN, {});
        result.uncertain += 1;
        return;
      case 'rejected': {
        const errorCode = String(outcome.code);
        if (outcome.retryable && job.attempts < job.maxAttempts) {
          await this.setStatus(row.id, MessageStatus.QUEUED, {});
          throw new JobError(`send_rejected_${errorCode}`, true);
        }
        await this.setStatus(row.id, MessageStatus.FAILED, { errorCode });
        result.failed += 1;
        if (outcome.retryable) {
          // Out of attempts: the reply is lost; fail the job visibly.
          throw new JobError(`send_rejected_${errorCode}`, false);
        }
        return;
      }
    }
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
