import { AiLimitsService } from '../../src/ai/ai-limits.service.js';
import { AiProviderError, type AiProvider } from '../../src/ai/ai.provider.js';
import { CatalogAiService } from '../../src/catalog/catalog-ai.service.js';
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { seedDefaultAgentProfile } from '../../src/agents/default-agent-profile.seed.js';
import { BotService } from '../../src/bot/bot.service.js';
import { CommandService } from '../../src/bot/command.service.js';
import type { ReplyGenerator } from '../../src/bot/reply-generator.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { loadContent } from '../../src/content/content.schema.js';
import {
  ContentService,
  DEFAULT_CONTENT_DIR,
} from '../../src/content/content.service.js';
import { ContextService } from '../../src/conversations/context.service.js';
import { DemosService } from '../../src/demos/demos.service.js';
import { LeadsService } from '../../src/leads/leads.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { ToolEffectsService } from '../../src/bot/tools/tool-effects.service.js';
import { type Env, parseEnv } from '../../src/config/env.schema.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { InboundText } from '../../src/whatsapp/inbound-event.js';
import type {
  WhatsAppClient,
  WhatsAppClientFactory,
} from '../../src/whatsapp/whatsapp.client.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';

/** AppConfigService over the validated test env, with optional overrides. */
export function testConfig(overrides: Partial<Env> = {}): AppConfigService {
  const env = { ...parseEnv(process.env), ...overrides };
  return { get: (key: keyof Env) => env[key] } as AppConfigService;
}

export async function connectPrisma(
  config = testConfig(),
): Promise<PrismaService> {
  const prisma = new PrismaService(config);
  await prisma.onModuleInit();
  return prisma;
}

const defaultContent = loadContent(DEFAULT_CONTENT_DIR);

/** Must match WHATSAPP_PHONE_NUMBER_ID in vitest.config.int.ts. */
export const DEFAULT_PHONE_NUMBER_ID = '000000000000000';

/**
 * Empties every table and recreates the default business, line and agent
 * profile (the ones `npm run seed:default-line` creates), so
 * inbound messages without an explicit line are routed as in production.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE conversation, conversation_context, message, processing_job,
      lead, demo_request, handoff_request, ai_usage, contact, webhook_event,
      line, agent_profile, agent_profile_version, push_subscription, membership, refresh_token, app_user, business
      RESTART IDENTITY CASCADE`;
  await createLine(prisma, {
    slug: 'botsuite46',
    phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
  });
  await seedDefaultAgentProfile(prisma, defaultContent.commercialInfo);
}

/** Creates a business with one line; returns its ids and route values. */
export async function createLine(
  prisma: PrismaService,
  {
    slug,
    phoneNumberId,
    appSecret,
  }: { slug: string; phoneNumberId: string; appSecret?: string },
): Promise<{
  businessId: string;
  lineId: string;
  webhookKey: string;
  verifyToken: string;
}> {
  const business = await prisma.business.create({
    data: { name: slug, slug, botName: `Bot de ${slug}` },
  });
  const line = await prisma.line.create({
    data: {
      businessId: business.id,
      phoneNumberId,
      verifyToken: `verify-${slug}`,
      webhookKey: `key-${slug}`.padEnd(24, '0'),
      ...(appSecret
        ? {
            appSecretEncrypted: new LineCredentialsService(
              testConfig(),
            ).encrypt(appSecret),
          }
        : {}),
    },
  });
  return {
    businessId: business.id,
    lineId: line.id,
    webhookKey: line.webhookKey,
    verifyToken: line.verifyToken,
  };
}

export function textEvent(
  waMessageId: string,
  from = '5491100001234',
  text = 'hola',
): InboundText {
  return {
    kind: 'text',
    phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
    waMessageId,
    from,
    timestamp: new Date('2026-10-11T12:00:00Z'),
    text,
  };
}

/**
 * BotService wired with the real context/command/effect services. A plain
 * client is used for every line; pass a factory to see which line sends.
 */
export function buildBotService(
  prisma: PrismaService,
  client: WhatsAppClient | WhatsAppClientFactory,
  generator: ReplyGenerator,
): BotService {
  const content = new ContentService();
  const contexts = new ContextService(prisma);
  const commands = new CommandService(contexts, content);
  const effects = new ToolEffectsService(
    new LeadsService(prisma),
    new DemosService(prisma, content),
    commands,
  );
  return new BotService(
    prisma,
    'forLine' in client ? client : fixedClientFactory(client),
    generator,
    contexts,
    commands,
    effects,
  );
}

/**
 * CatalogService with its model calls going to `provider` (by default one
 * that fails, as in echo mode: no mapping proposals, no documents).
 */
export function buildCatalogService(
  prisma: PrismaService,
  config: AppConfigService,
  provider: AiProvider = {
    respond: () => Promise.reject(new AiProviderError('ai_disabled', false)),
  },
): CatalogService {
  return new CatalogService(
    prisma,
    config,
    new CatalogAiService(
      provider,
      prisma,
      config,
      new AiLimitsService(prisma, config),
    ),
  );
}
