import { AppConfigService } from '../../src/config/app-config.service.js';
import { type Env, parseEnv } from '../../src/config/env.schema.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { InboundText } from '../../src/whatsapp/inbound-event.js';

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
