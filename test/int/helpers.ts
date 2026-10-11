import { BotService } from '../../src/bot/bot.service.js';
import { CommandService } from '../../src/bot/command.service.js';
import type { ReplyGenerator } from '../../src/bot/reply-generator.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ContentService } from '../../src/content/content.service.js';
import { ContextService } from '../../src/conversations/context.service.js';
import { type Env, parseEnv } from '../../src/config/env.schema.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { InboundText } from '../../src/whatsapp/inbound-event.js';
import type { WhatsAppClient } from '../../src/whatsapp/whatsapp.client.js';

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

export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE conversation, conversation_context, message, processing_job,
      lead, demo_request, handoff_request, ai_usage RESTART IDENTITY CASCADE`;
}

export function textEvent(
  waMessageId: string,
  from = '5491100001234',
  text = 'hola',
): InboundText {
  return {
    kind: 'text',
    waMessageId,
    from,
    timestamp: new Date('2026-10-11T12:00:00Z'),
    text,
  };
}

/** BotService wired with the real context/command services. */
export function buildBotService(
  prisma: PrismaService,
  client: WhatsAppClient,
  generator: ReplyGenerator,
): BotService {
  const contexts = new ContextService(prisma);
  const commands = new CommandService(contexts, new ContentService());
  return new BotService(prisma, client, generator, contexts, commands);
}
