import { z } from 'zod';
import { worstCaseAiJobMs } from '../ai/ai-limits.js';

const GRAPH_API_VERSION_PATTERN = /^v\d+\.\d+$/;
const ADMIN_API_KEY_MIN_LENGTH = 32;
const JWT_SECRET_MIN_LENGTH = 32;
const MEDIA_URL_SECRET_MIN_LENGTH = 32;
/** Scheme, host and optional port: what a browser sends in Origin. */
const ORIGIN_PATTERN = /^https?:\/\/[^\s/:]+(:\d{1,5})?$/;
const ENCRYPTION_KEY_BYTES = 32;

/** True when `value` is canonical base64 for exactly `bytes` bytes. */
function isBase64Key(value: string, bytes: number): boolean {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value;
}

const requiredString = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`);

/** Optional string; blank counts as not set. */
const optionalString = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined));

/** Optional http(s) URL without a trailing slash; blank counts as not set. */
const optionalUrl = (name: string) =>
  optionalString()
    .refine(
      (value) =>
        value === undefined || /^https?:\/\/[^\s/]+(\/\S*)?$/.test(value),
      `${name} must be an http(s) URL`,
    )
    .transform((value) => value?.replace(/\/+$/, ''));

/** True when `value` is unpadded base64url for exactly `bytes` bytes. */
function isBase64UrlKey(value: string, bytes: number): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').length === bytes
  );
}

/** VAPID keys: an uncompressed P-256 public key and its private scalar. */
const VAPID_PUBLIC_KEY_BYTES = 65;
const VAPID_PRIVATE_KEY_BYTES = 32;
const VAPID_KEYS = [
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
] as const;

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

    // The default line (BotSuite46), served by the keyless webhook route and
    // created by `npm run seed:default-line`. All optional: without them the
    // app starts and the keyless route answers 404. Other lines keep their
    // own credentials in the database.
    META_APP_SECRET: optionalString(),
    WHATSAPP_VERIFY_TOKEN: optionalString(),
    WHATSAPP_ACCESS_TOKEN: optionalString(),
    WHATSAPP_PHONE_NUMBER_ID: optionalString(),
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
    // Audio transcription (prompt 11): model and per-call timeout.
    OPENAI_TRANSCRIBE_MODEL: z
      .string()
      .trim()
      .min(1, 'OPENAI_TRANSCRIBE_MODEL must not be empty')
      .default('gpt-4o-mini-transcribe'),
    OPENAI_TRANSCRIBE_TIMEOUT_MS: positiveInt(
      'OPENAI_TRANSCRIBE_TIMEOUT_MS',
      30_000,
    ),
    // Attachment limits (prompt 11). Per business: audio_max_seconds and
    // media_daily_cap_per_conversation.
    MEDIA_AUDIO_MAX_SECONDS: positiveInt('MEDIA_AUDIO_MAX_SECONDS', 120),
    MEDIA_AUDIO_MAX_BYTES: positiveInt('MEDIA_AUDIO_MAX_BYTES', 1_000_000),
    MEDIA_IMAGE_MAX_BYTES: positiveInt('MEDIA_IMAGE_MAX_BYTES', 5_000_000),
    MEDIA_DOCUMENT_MAX_BYTES: positiveInt(
      'MEDIA_DOCUMENT_MAX_BYTES',
      10_000_000,
    ),
    MEDIA_MAX_PER_CONVERSATION_PER_DAY: positiveInt(
      'MEDIA_MAX_PER_CONVERSATION_PER_DAY',
      10,
    ),
    // Default monthly cap of a business without its own (Business.aiMonthlyCap).
    AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH: positiveInt(
      'AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH',
      5_000,
    ),
    AI_HISTORY_LIMIT: positiveInt('AI_HISTORY_LIMIT', 12),
    // Default item cap of a business without its own (Business.catalogItemCap).
    CATALOG_MAX_ITEMS_PER_BUSINESS: positiveInt(
      'CATALOG_MAX_ITEMS_PER_BUSINESS',
      2_000,
    ),
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
    QUEUE_LEASE_MS: positiveInt('QUEUE_LEASE_MS', 180_000),

    // Public base URL of this API, used to build each line's webhook URL in
    // the admin API (e.g. https://bottega-api.onrender.com). Render sets
    // RENDER_EXTERNAL_URL itself; PUBLIC_BASE_URL wins when both are set.
    PUBLIC_BASE_URL: optionalUrl('PUBLIC_BASE_URL'),
    RENDER_EXTERNAL_URL: optionalUrl('RENDER_EXTERNAL_URL'),

    // Encrypts per-line Meta credentials at rest (AES-256-GCM). Losing or
    // changing it makes the stored credentials unreadable.
    TOKEN_ENCRYPTION_KEY: requiredString('TOKEN_ENCRYPTION_KEY').refine(
      (value) => isBase64Key(value, ENCRYPTION_KEY_BYTES),
      'TOKEN_ENCRYPTION_KEY must be 32 bytes encoded in base64 (openssl rand -base64 32)',
    ),

    ADMIN_API_KEY: requiredString('ADMIN_API_KEY').min(
      ADMIN_API_KEY_MIN_LENGTH,
      `ADMIN_API_KEY must be at least ${ADMIN_API_KEY_MIN_LENGTH} characters`,
    ),

    // Signs the inbox's attachment links (HMAC). Changing it only expires the
    // links already handed out.
    MEDIA_URL_SECRET: requiredString('MEDIA_URL_SECRET').min(
      MEDIA_URL_SECRET_MIN_LENGTH,
      `MEDIA_URL_SECRET must be at least ${MEDIA_URL_SECRET_MIN_LENGTH} characters`,
    ),

    // Signs the inbox session JWTs (HS256). Changing it ends every session.
    JWT_SECRET: requiredString('JWT_SECRET').min(
      JWT_SECRET_MIN_LENGTH,
      `JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters`,
    ),

    // The only origin allowed by CORS (with credentials): the inbox web app.
    // Lowercased: browsers send the Origin header in lowercase.
    INBOX_ORIGIN: requiredString('INBOX_ORIGIN')
      .regex(
        ORIGIN_PATTERN,
        'INBOX_ORIGIN must be an origin like https://inbox.example.com (scheme, host and optional port, no path)',
      )
      .transform((value) => value.toLowerCase()),

    // Web Push to the inbox (the three or none; none turns push off).
    // Generate the pair with `npx web-push generate-vapid-keys`.
    VAPID_PUBLIC_KEY: optionalString().refine(
      (value) =>
        value === undefined || isBase64UrlKey(value, VAPID_PUBLIC_KEY_BYTES),
      'VAPID_PUBLIC_KEY must be a P-256 public key in base64url (npx web-push generate-vapid-keys)',
    ),
    VAPID_PRIVATE_KEY: optionalString().refine(
      (value) =>
        value === undefined || isBase64UrlKey(value, VAPID_PRIVATE_KEY_BYTES),
      'VAPID_PRIVATE_KEY must be a P-256 private key in base64url (npx web-push generate-vapid-keys)',
    ),
    // Contact for the push services: mailto:someone@example.com or a URL.
    VAPID_SUBJECT: optionalString().refine(
      (value) =>
        value === undefined || /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(value),
      'VAPID_SUBJECT must be a mailto: or https: URL',
    ),
  })
  .superRefine(
    (env, ctx) => {
      // Raw presence (a malformed value already has its own issue).
      const set = VAPID_KEYS.filter((key) => env[key] !== undefined);
      if (set.length > 0 && set.length < VAPID_KEYS.length) {
        for (const key of VAPID_KEYS) {
          if (env[key] === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: `${key} is required when another VAPID_* variable is set (set the three or none)`,
            });
          }
        }
      }
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
        typeof env.OPENAI_TRANSCRIBE_TIMEOUT_MS === 'number' &&
        typeof env.WHATSAPP_HTTP_TIMEOUT_MS === 'number'
      ) {
        const needed = worstCaseAiJobMs(env);
        if (env.QUEUE_LEASE_MS <= needed) {
          ctx.addIssue({
            code: 'custom',
            path: ['QUEUE_LEASE_MS'],
            message: `QUEUE_LEASE_MS must be greater than ${needed} (attachment fetch x WHATSAPP_HTTP_TIMEOUT_MS + OPENAI_TRANSCRIBE_TIMEOUT_MS + model rounds x OPENAI_TIMEOUT_MS + sends x WHATSAPP_HTTP_TIMEOUT_MS + overhead) when BOT_REPLY_MODE=ai`,
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
