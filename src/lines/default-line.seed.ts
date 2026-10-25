import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { UTC_NOW } from '../prisma/sql.js';
import type { CredentialsCipher } from './credentials-cipher.js';

export const DEFAULT_BUSINESS_SLUG = 'botsuite46';
export const DEFAULT_BUSINESS_NAME = 'BotSuite46';
export const DEFAULT_BOT_NAME = 'BotSuite, IA de BotSuite46';

/** The env values that describe the default line (all optional). */
export interface DefaultLineEnv {
  WHATSAPP_PHONE_NUMBER_ID?: string;
  META_APP_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
}

export type SeedResult =
  | { outcome: 'skipped' }
  | { outcome: 'seeded'; lineId: string; backfilled: number };

/** 24 URL-safe characters (18 random bytes). */
export function newWebhookKey(): string {
  return randomBytes(18).toString('base64url');
}

/** 64 hex characters, for the Meta webhook "Verify token" field. */
export function newVerifyToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Creates (or updates) the default business and line from the env, and
 * assigns every conversation that has no line yet to it, creating the
 * matching contacts. Idempotent: safe to run on every deploy. Generated keys
 * are never regenerated; stored credentials follow the env values.
 */
export async function seedDefaultLine(
  prisma: PrismaClient,
  cipher: CredentialsCipher,
  env: DefaultLineEnv,
): Promise<SeedResult> {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    return { outcome: 'skipped' };
  }
  const credentials = {
    ...(env.META_APP_SECRET
      ? { appSecretEncrypted: cipher.encrypt(env.META_APP_SECRET) }
      : {}),
    ...(env.WHATSAPP_ACCESS_TOKEN
      ? { accessTokenEncrypted: cipher.encrypt(env.WHATSAPP_ACCESS_TOKEN) }
      : {}),
  };

  return prisma.$transaction(async (tx) => {
    const business = await tx.business.upsert({
      where: { slug: DEFAULT_BUSINESS_SLUG },
      create: {
        slug: DEFAULT_BUSINESS_SLUG,
        name: DEFAULT_BUSINESS_NAME,
        botName: DEFAULT_BOT_NAME,
      },
      // Name and botName may have been edited since: keep them.
      update: {},
    });
    const line = await tx.line.upsert({
      where: { phoneNumberId },
      create: {
        businessId: business.id,
        phoneNumberId,
        verifyToken: newVerifyToken(),
        webhookKey: newWebhookKey(),
        ...credentials,
      },
      update: credentials,
    });

    await tx.$executeRaw`
      INSERT INTO contact (id, business_id, wa_id, created_at, updated_at)
      SELECT gen_random_uuid(), ${line.businessId}::uuid, c.wa_id,
        ${UTC_NOW}, ${UTC_NOW}
      FROM (SELECT DISTINCT wa_id FROM conversation WHERE line_id IS NULL) c
      ON CONFLICT (business_id, wa_id) DO NOTHING`;
    const backfilled = await tx.$executeRaw`
      UPDATE conversation c
      SET line_id = ${line.id}::uuid, contact_id = ct.id
      FROM contact ct
      WHERE c.line_id IS NULL
        AND ct.business_id = ${line.businessId}::uuid
        AND ct.wa_id = c.wa_id`;

    return { outcome: 'seeded', lineId: line.id, backfilled } as const;
  });
}
