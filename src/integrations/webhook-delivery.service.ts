import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobError } from '../bot/job-error.js';
import { CredentialsDecryptError } from '../lines/credentials-cipher.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { WebhookJobProcessor } from '../queue/push-jobs.js';
import type { WebhookJob } from '../queue/queue.service.js';
import { BlockedAddressError, ResponseTooLargeError } from './safe-fetch.js';
import {
  SIGNATURE_HEADER,
  signWebhook,
  TIMESTAMP_HEADER,
} from './webhook-signature.js';

/** The fetch used for deliveries (tests replace it). */
export const WEBHOOK_FETCH = Symbol('WEBHOOK_FETCH');

const TIMEOUT_MS = 10_000;

/** A static label for a failed request (never the URL or the body). */
export function fetchErrorCode(error: unknown): string {
  if (error instanceof BlockedAddressError) {
    return 'blocked_address';
  }
  if (error instanceof ResponseTooLargeError) {
    return 'response_too_large';
  }
  return error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? 'timeout'
    : 'network_error';
}

/**
 * Sends one WEBHOOK_DELIVERY job: the stored event body, signed with the
 * subscription's secret, as a POST through the SSRF-safe fetch (see
 * createSafeFetch). A 2xx is delivered; anything else (other status,
 * redirect, timeout, network error) is recorded on the delivery and the
 * subscription and retried by the queue up to the job's attempts; a host
 * that resolves to a non-public address fails without retries. A subscription turned off (or deleted) ends the job SKIPPED.
 * Never logs the URL, the secret or the body.
 */
@Injectable()
export class WebhookDeliveryService implements WebhookJobProcessor {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    @Inject(WEBHOOK_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  async process(job: WebhookJob): Promise<'done' | 'skipped'> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: job.deliveryId },
      include: { subscription: true },
    });
    if (!delivery?.subscription.active) {
      return 'skipped';
    }
    const { subscription } = delivery;
    let secret: string;
    try {
      secret = this.credentials.decrypt(subscription.secretEncrypted);
    } catch (error) {
      if (!(error instanceof CredentialsDecryptError)) {
        throw error;
      }
      await this.recordFailure(
        delivery.id,
        subscription.id,
        'secret_unreadable',
        null,
      );
      throw new JobError('secret_unreadable', false);
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let status: number;
    try {
      const response = await this.fetchImpl(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Bottega-Webhooks/1',
          'X-Bottega-Event': delivery.event,
          'X-Bottega-Event-Id': delivery.eventId,
          'X-Bottega-Delivery': delivery.id,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
        },
        body,
        // A redirect is a failure: the event only goes to the registered URL.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      // The body is not needed; release the connection.
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      const code = fetchErrorCode(error);
      await this.recordFailure(delivery.id, subscription.id, code, null);
      this.logger.warn(
        `Webhook delivery ${delivery.id} (subscription ${subscription.id}): ${code}`,
      );
      // A private address stays private: retrying it only burns attempts.
      throw new JobError(code, code !== 'blocked_address');
    }

    if (status >= 200 && status < 300) {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { deliveredAt: now, responseStatus: status, lastError: null },
        }),
        this.prisma.webhookSubscription.update({
          where: { id: subscription.id },
          data: { lastSuccessAt: now },
        }),
      ]);
      return 'done';
    }
    const code = `http_${status}`;
    await this.recordFailure(delivery.id, subscription.id, code, status);
    this.logger.warn(
      `Webhook delivery ${delivery.id} (subscription ${subscription.id}): ${code}`,
    );
    throw new JobError(code, true);
  }

  private async recordFailure(
    deliveryId: string,
    subscriptionId: string,
    code: string,
    status: number | null,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { lastError: code, responseStatus: status },
      }),
      this.prisma.webhookSubscription.update({
        where: { id: subscriptionId },
        data: { lastError: code, lastErrorAt: now },
      }),
    ]);
  }
}
