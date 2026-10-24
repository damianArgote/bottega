import { z } from 'zod';
import { worstCaseAiJobMs } from '../ai/ai-limits.js';

const GRAPH_API_VERSION_PATTERN = /^v\d+\.\d+$/;
const ADMIN_API_KEY_MIN_LENGTH = 32;

const requiredString = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`);

const positiveInt = (name: string, defaultValue: number) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .positive(`${name} must be greater than 0`)
    .default(defaultValue);

/**
 * Environment variables accepted by bottega-api.
 *
 * Validation runs once at boot; any failure stops the application.
 * Error messages are built from variable names and rules only, never from
 * the provided values, so secrets can't leak into logs.
 */
export const envSchema = z
  .object({
    PORT: z.coerce
      .number({ error: 'PORT must be a number' })
      .int('PORT must be an integer')
      .min(1, 'PORT must be between 1 and 65535')
      .max(65535, 'PORT must be between 1 and 65535')
      .default(3000),
    NODE_ENV: z
      .enum(['development', 'test', 'production'], {
        error: 'NODE_ENV must be one of: development, test, production',
      })
      .default('development'),

    DATABASE_URL: requiredString('DATABASE_URL').refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'DATABASE_URL must be a postgresql:// connection string',
    ),
    // Direct (non-pooled) connection, used only by the Prisma CLI for
    // migrations (see prisma.config.ts). The app itself uses DATABASE_URL.
    DATABASE_URL_UNPOOLED: z
      .string()
      .trim()
      .optional()
      .refine(
        (value) => !value || /^postgres(ql)?:\/\//.test(value),
        'DATABASE_URL_UNPOOLED must be a postgresql:// connection string',
      ),

    META_APP_SECRET: requiredString('META_APP_SECRET'),
    WHATSAPP_VERIFY_TOKEN: requiredString('WHATSAPP_VERIFY_TOKEN'),
    WHATSAPP_ACCESS_TOKEN: requiredString('WHATSAPP_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: requiredString('WHATSAPP_PHONE_NUMBER_ID'),
    WHATSAPP_GRAPH_API_VERSION: requiredString(
      'WHATSAPP_GRAPH_API_VERSION',
    ).regex(
      GRAPH_API_VERSION_PATTERN,
      'WHATSAPP_GRAPH_API_VERSION must look like v26.0',
    ),
    // Upper bound for one Graph API send. A send that times out is treated as
    // "uncertain" (Meta may have accepted it) and never auto-resent, so keep it
    // generous enough for slow responses but short enough not to stall workers.
    WHATSAPP_HTTP_TIMEOUT_MS: positiveInt('WHATSAPP_HTTP_TIMEOUT_MS', 10_000),

    BOT_REPLY_MODE: z
      .enum(['echo', 'ai'], { error: 'BOT_REPLY_MODE must be "echo" or "ai"' })
      .default('echo'),
    OPENAI_API_KEY: z.string().trim().optional(),
    OPENAI_MODEL: z.string().trim().optional(),
    OPENAI_TIMEOUT_MS: positiveInt('OPENAI_TIMEOUT_MS', 20_000),
    OPENAI_MAX_OUTPUT_TOKENS: positiveInt('OPENAI_MAX_OUTPUT_TOKENS', 300),
    AI_MAX_INTERACTIONS_PER_USER_PER_DAY: positiveInt(
      'AI_MAX_INTERACTIONS_PER_USER_PER_DAY',
      30,
    ),
    AI_HISTORY_LIMIT: positiveInt('AI_HISTORY_LIMIT', 12),
    JOB_MAX_ATTEMPTS: positiveInt('JOB_MAX_ATTEMPTS', 4),

    // Background worker that drains the PostgreSQL job queue. Disabled in tests
    // (which drive the worker by hand) or to run an API-only instance.
    WORKER_ENABLED: z
      .enum(['true', 'false'], {
        error: 'WORKER_ENABLED must be "true" or "false"',
      })
      .default('true')
      .transform((value) => value === 'true'),
    // How often an idle worker polls for new jobs: the worst-case extra reply
    // latency, traded against one cheap indexed query per interval.
    QUEUE_POLL_INTERVAL_MS: positiveInt('QUEUE_POLL_INTERVAL_MS', 1_000),
    // Poll interval once a round found no work. Long on purpose so a
    // serverless database (Neon) can suspend; new jobs wake the worker
    // in-process and due retries are polled at their run_after.
    QUEUE_IDLE_POLL_INTERVAL_MS: positiveInt(
      'QUEUE_IDLE_POLL_INTERVAL_MS',
      600_000,
    ),
    // Jobs processed in parallel (each on a different conversation). Small by
    // default to stay within the WhatsApp throughput and DB pool limits.
    QUEUE_CONCURRENCY: positiveInt('QUEUE_CONCURRENCY', 2),
    // A claimed job is reclaimable after this. Must exceed the worst-case job
    // time (AI call + several sends with WHATSAPP_HTTP_TIMEOUT_MS each), or a
    // slow job could be picked up twice.
    QUEUE_LEASE_MS: positiveInt('QUEUE_LEASE_MS', 120_000),

    ADMIN_API_KEY: requiredString('ADMIN_API_KEY').min(
      ADMIN_API_KEY_MIN_LENGTH,
      `ADMIN_API_KEY must be at least ${ADMIN_API_KEY_MIN_LENGTH} characters`,
    ),
  })
  .superRefine(
    (env, ctx) => {
      if (env.BOT_REPLY_MODE !== 'ai') {
        return;
      }
      for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when BOT_REPLY_MODE=ai`,
          });
        }
      }
      // A job holds its lease for the whole AI turn plus the sends; if the
      // lease could expire first, another worker might claim the job twice.
      // Checked here (fail fast at boot) instead of extending the lease
      // between model rounds.
      if (
        typeof env.QUEUE_LEASE_MS === 'number' &&
        typeof env.OPENAI_TIMEOUT_MS === 'number' &&
        typeof env.WHATSAPP_HTTP_TIMEOUT_MS === 'number'
      ) {
        const needed = worstCaseAiJobMs(env);
        if (env.QUEUE_LEASE_MS <= needed) {
          ctx.addIssue({
            code: 'custom',
            path: ['QUEUE_LEASE_MS'],
            message: `QUEUE_LEASE_MS must be greater than ${needed} (model rounds x OPENAI_TIMEOUT_MS + sends x WHATSAPP_HTTP_TIMEOUT_MS + overhead) when BOT_REPLY_MODE=ai`,
          });
        }
      }
    },
    // Run even when other fields failed, so every problem is reported at once.
    // `env` may then be partially invalid: the checks above guard their types.
    { when: () => true },
  );

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid environment configuration:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses and validates raw environment variables.
 * Throws {@link EnvValidationError} listing every problem (names only, no values).
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    // issue.message is always one of the static messages defined above or a
    // generic zod message; zod does not include input values unless asked to.
    return `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(problems);
}
