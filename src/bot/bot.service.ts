import { Inject, Injectable, Logger } from '@nestjs/common';
import { ContextService } from '../conversations/context.service.js';
import {
  type Conversation,
  type Message,
  MessageAuthor,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ClaimedJob } from '../queue/queue.service.js';
import {
  maskPhone,
  WHATSAPP_CLIENT,
  type SendOutcome,
  type WhatsAppClient,
} from '../whatsapp/whatsapp.client.js';
import { CommandService } from './command.service.js';
import { matchCommand } from './commands.js';
import { JobError } from './job-error.js';
import { REPLY_GENERATOR, type ReplyGenerator } from './reply-generator.js';
import {
  ToolEffectsService,
  type GeneratedOutcome,
} from './tools/tool-effects.service.js';

export { JobError };

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
 * 1. Generate: apply a deterministic command or call the reply generator,
 *    and persist the replies as QUEUED outbound messages (idempotency key
 *    `${jobId}:${index}`) in the same transaction that marks the inbound
 *    message PROCESSED (and applies the command's transition or the tool
 *    effects). That status is the phase marker: a retried job never
 *    generates, transitions or applies effects again.
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
    private readonly contexts: ContextService,
    private readonly commands: CommandService,
    private readonly effects: ToolEffectsService,
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

    // The PROCESSED status is the phase marker: once set, a retried job only
    // sends what was persisted, never re-generating or re-applying a command.
    if (inbound.status === MessageStatus.RECEIVED) {
      const phase = await this.generateReplies(job, inbound, conversation);
      if (phase === 'paused') {
        this.logger.log(
          `Job ${job.id}: conversation paused, no reply to ${to}`,
        );
        return { outcome: 'paused', sent: 0, uncertain: 0, failed: 0 };
      }
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

  /**
   * Phase 1. A text that is exactly a command applies its transition
   * (CommandService) and stores its fixed reply; anything else goes to the
   * reply generator, whose planned tool effects (lead, demo request,
   * handoff) are applied here (ToolEffectsService). Either way the replies,
   * the transition or effects and the inbound PROCESSED marker commit in one
   * transaction. A paused conversation (also
   * re-checked under the row lock) stores the message with no reply and
   * runs no command.
   */
  private async generateReplies(
    job: ClaimedJob,
    inbound: Message,
    conversation: Conversation,
  ): Promise<'paused' | 'done'> {
    const command =
      inbound.type === MessageType.TEXT ? matchCommand(inbound.content) : null;

    let generated: GeneratedOutcome | null = null;
    if (!conversation.paused && !command) {
      const contextId = conversation.activeContextId ?? inbound.contextId;
      if (!contextId) {
        throw new JobError('active_context_missing', false);
      }
      const { replies, effects } = await this.generator.generate({
        conversationId: conversation.id,
        mode: conversation.mode,
        contextId,
        message: {
          id: inbound.id,
          type: inbound.type,
          content: inbound.content,
        },
        isLastAttempt: job.attempts >= job.maxAttempts,
      });
      generated = { contextId, replies, effects };
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.contexts.lock(tx, conversation.id);
      const paused = conversation.paused || locked.paused;
      const { count } = await tx.message.updateMany({
        where: { id: inbound.id, status: MessageStatus.RECEIVED },
        // A message processed after a context change belongs to the context
        // it was answered in, so per-context history stays coherent.
        data: {
          status: MessageStatus.PROCESSED,
          ...(generated && !paused ? { contextId: generated.contextId } : {}),
        },
      });
      if (count !== 1) {
        // Another run persisted this job's phase 1 first: roll back ours.
        throw new JobError('generate_conflict', true);
      }
      if (paused) {
        return 'paused';
      }

      const { contextId, replies } = command
        ? await this.commands.apply(tx, conversation.id, command)
        : await this.effects.apply(tx, conversation.id, generated!);
      if (replies.length > 0) {
        await tx.message.createMany({
          data: replies.map((content, index) => ({
            conversationId: conversation.id,
            contextId,
            direction: MessageDirection.OUTBOUND,
            type: MessageType.TEXT,
            content,
            status: MessageStatus.QUEUED,
            author: MessageAuthor.BOT,
            idempotencyKey: `${job.id}:${index}`,
          })),
        });
      }
      return 'done';
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
