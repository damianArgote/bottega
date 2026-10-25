// Creates or updates the default business and line from the env and assigns
// every conversation without a line to it. Idempotent: Render runs it after
// the migrations on every deploy (render.yaml preDeployCommand).
// Usage: npm run build && npm run seed:default-line
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { EnvValidationError, parseEnv } from '../config/env.schema.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { CredentialsCipher } from '../lines/credentials-cipher.js';
import { seedDefaultLine } from '../lines/default-line.seed.js';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const cipher = new CredentialsCipher(
      Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'),
    );
    const result = await seedDefaultLine(prisma, cipher, env);
    console.log(
      result.outcome === 'skipped'
        ? 'seed:default-line skipped: WHATSAPP_PHONE_NUMBER_ID is not set'
        : `seed:default-line done: line ${result.lineId}, ${result.backfilled} conversation(s) backfilled`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // EnvValidationError lists variable names only, never values; any other
  // message may include connection details, so only its name is printed.
  console.error(
    error instanceof EnvValidationError
      ? `seed:default-line failed: ${error.message}`
      : `seed:default-line failed: ${error instanceof Error ? error.name : 'UnknownError'}`,
  );
  process.exitCode = 1;
});
