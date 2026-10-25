import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobError } from '../bot/job-error.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PushJobProcessor } from '../queue/push-jobs.js';
import type { PushJob } from '../queue/queue.service.js';
import { vapidDetails } from './push-config.js';
import { buildPushPayload, pushRecipients } from './push-rules.js';
import { PUSH_SENDER, type PushSender } from './push-sender.js';

/** Kept by the push service for an offline browser: a stale alert is noise. */
const PUSH_TTL_SECONDS = 60 * 60;

/**
 * Runs PUSH_NOTIFICATION jobs: decides the recipients with the
 * conversation's current state and sends the push to each of their
 * browsers. A subscription the push service no longer knows (404/410) is
 * deleted; any other failure retries the job, skipping the browsers that
 * already got it. Logs counts only: never endpoints, keys or content.
 */
@Injectable()
export class PushService implements PushJobProcessor {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  async process(job: PushJob): Promise<'done' | 'skipped'> {
    if (!vapidDetails(this.config)) {
      return 'skipped';
    }
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: job.conversationId },
      select: {
        status: true,
        assignedToId: true,
        paused: true,
        line: { select: { businessId: true } },
        contact: { select: { name: true, profileName: true, waId: true } },
      },
    });
    if (!conversation) {
      return 'skipped';
    }
    const { businessId } = conversation.line;
    const memberships = await this.prisma.membership.findMany({
      where: { businessId },
      select: {
        userId: true,
        active: true,
        user: { select: { active: true } },
      },
    });
    const recipients = pushRecipients({
      reason: job.pushReason,
      conversation,
      members: memberships.map((m) => ({
        userId: m.userId,
        active: m.active && m.user.active,
      })),
    });
    if (recipients.length === 0) {
      return 'skipped';
    }
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId: { in: recipients } },
      select: {
        id: true,
        endpoint: true,
        p256dh: true,
        auth: true,
        lastSuccessAt: true,
      },
    });
    // A retry skips the browsers an earlier attempt already reached. Only
    // on a retry: another push of the conversation, sent after this job was
    // created, also moves lastSuccessAt.
    const pending =
      job.attempts > 1
        ? subscriptions.filter(
            (s) => !s.lastSuccessAt || s.lastSuccessAt < job.createdAt,
          )
        : subscriptions;
    if (pending.length === 0) {
      return subscriptions.length === 0 ? 'skipped' : 'done';
    }

    const payload = JSON.stringify(
      buildPushPayload({
        reason: job.pushReason,
        businessId,
        conversationId: job.conversationId,
        contact: conversation.contact,
        message: await this.messageOf(job),
      }),
    );
    // Web Push topics allow 32 URL-safe characters: the id without hyphens.
    const topic = job.conversationId.replaceAll('-', '');
    let accepted = 0;
    let gone = 0;
    let failed = 0;
    for (const subscription of pending) {
      const outcome = await this.sender.send(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        { ttl: PUSH_TTL_SECONDS, topic },
      );
      if (outcome.kind === 'accepted') {
        accepted += 1;
        await this.prisma.pushSubscription.updateMany({
          where: { id: subscription.id },
          data: { lastSuccessAt: new Date() },
        });
      } else if (outcome.kind === 'gone') {
        gone += 1;
        await this.prisma.pushSubscription.deleteMany({
          where: { id: subscription.id },
        });
      } else {
        failed += 1;
      }
    }
    this.logger.log(
      `Push job ${job.id} (${job.pushReason.toLowerCase()}): recipients=${recipients.length} accepted=${accepted} gone=${gone} failed=${failed}`,
    );
    if (failed > 0) {
      throw new JobError('push_send_failed', true);
    }
    return 'done';
  }

  /** The job's message, or for a handoff the latest one from the contact. */
  private messageOf(job: PushJob) {
    const select = { type: true, content: true } as const;
    return job.messageId
      ? this.prisma.message.findUnique({ where: { id: job.messageId }, select })
      : this.prisma.message.findFirst({
          where: {
            conversationId: job.conversationId,
            direction: 'INBOUND',
            author: 'USER',
          },
          orderBy: { seq: 'desc' },
          select,
        });
  }
}
