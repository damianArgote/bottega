import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EVENT_TYPES } from './events.js';

/** Key format: `btg_` + 43 URL-safe characters (32 random bytes). */
const KEY_PREFIX = 'btg_';
/** Characters of a key kept to recognize it in a list (`btg_` + 6). */
const SHOWN_PREFIX_LENGTH = KEY_PREFIX.length + 6;

const httpsUrl = z
  .url({ protocol: /^https$/, message: 'must be an https URL' })
  .max(2000);
const events = z
  .array(z.enum(EVENT_TYPES))
  .min(1)
  .max(EVENT_TYPES.length)
  .transform((list) => [...new Set(list)]);

export const createSubscriptionSchema = z
  .object({ url: httpsUrl, events })
  .strict();
export const updateSubscriptionSchema = z
  .object({
    url: httpsUrl.optional(),
    events: events.optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const createKeySchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

const subscriptionView = {
  id: true,
  url: true,
  events: true,
  active: true,
  lastSuccessAt: true,
  lastErrorAt: true,
  lastError: true,
  createdAt: true,
} as const;

const keyView = {
  id: true,
  name: true,
  prefix: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** SHA-256 of a key, as stored and looked up. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * A business's webhook subscriptions and integration keys, for the admin
 * API and the staff routes. Secrets and keys are returned only by the call
 * that creates them (or rotates the secret); later reads never include
 * them. Every call is scoped to the business (404 otherwise).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
  ) {}

  async listSubscriptions(businessId: string) {
    await this.business(businessId);
    return this.prisma.webhookSubscription.findMany({
      where: { businessId },
      select: subscriptionView,
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Returns the subscription and its signing `secret` (shown once). */
  async createSubscription(
    businessId: string,
    input: z.infer<typeof createSubscriptionSchema>,
  ) {
    await this.business(businessId);
    const secret = newSecret();
    const subscription = await this.prisma.webhookSubscription.create({
      data: {
        businessId,
        url: input.url,
        events: input.events,
        secretEncrypted: this.credentials.encrypt(secret),
      },
      select: subscriptionView,
    });
    return { ...subscription, secret };
  }

  async updateSubscription(
    businessId: string,
    subscriptionId: string,
    input: z.infer<typeof updateSubscriptionSchema>,
  ) {
    await this.subscription(businessId, subscriptionId);
    return this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: input,
      select: subscriptionView,
    });
  }

  /** A new secret; the old one stops signing at once. Shown once. */
  async rotateSecret(businessId: string, subscriptionId: string) {
    await this.subscription(businessId, subscriptionId);
    const secret = newSecret();
    const subscription = await this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { secretEncrypted: this.credentials.encrypt(secret) },
      select: subscriptionView,
    });
    return { ...subscription, secret };
  }

  /** Deletes it with its deliveries and their pending jobs. */
  async deleteSubscription(businessId: string, subscriptionId: string) {
    await this.subscription(businessId, subscriptionId);
    await this.prisma.webhookSubscription.delete({
      where: { id: subscriptionId },
    });
  }

  listKeys(businessId: string) {
    return this.business(businessId).then(() =>
      this.prisma.integrationKey.findMany({
        where: { businessId },
        select: keyView,
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** Returns the key record and the `key` itself (shown once). */
  async createKey(businessId: string, input: z.infer<typeof createKeySchema>) {
    await this.business(businessId);
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record = await this.prisma.integrationKey.create({
      data: {
        businessId,
        name: input.name,
        keyHash: hashKey(key),
        prefix: key.slice(0, SHOWN_PREFIX_LENGTH),
      },
      select: keyView,
    });
    return { ...record, key };
  }

  /** Revokes it at once (idempotent); the record stays for the list. */
  async revokeKey(businessId: string, keyId: string) {
    const key = await this.prisma.integrationKey.findFirst({
      where: { id: keyId, businessId },
      select: { id: true, revokedAt: true },
    });
    if (!key) {
      throw new NotFoundException('Integration key not found');
    }
    return this.prisma.integrationKey.update({
      where: { id: key.id },
      data: { revokedAt: key.revokedAt ?? new Date() },
      select: keyView,
    });
  }

  private async business(businessId: string): Promise<void> {
    const found = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Business not found');
    }
  }

  private async subscription(businessId: string, subscriptionId: string) {
    const found = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, businessId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Webhook subscription not found');
    }
  }
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
