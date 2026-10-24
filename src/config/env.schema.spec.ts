import { EnvValidationError, parseEnv } from './env.schema.js';

const SECRETS = {
  META_APP_SECRET: 'meta-secret-value-should-never-leak',
  WHATSAPP_VERIFY_TOKEN: 'verify-token-value-should-never-leak',
  WHATSAPP_ACCESS_TOKEN: 'access-token-value-should-never-leak',
  OPENAI_API_KEY: 'sk-openai-value-should-never-leak',
  ADMIN_API_KEY: 'admin-key-value-should-never-leak-0123456789',
};

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgresql://user:db-password-never-leak@localhost:5432/db',
    META_APP_SECRET: SECRETS.META_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: SECRETS.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_ACCESS_TOKEN: SECRETS.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_GRAPH_API_VERSION: 'v26.0',
    ADMIN_API_KEY: SECRETS.ADMIN_API_KEY,
    ...overrides,
  };
}

function captureError(raw: Record<string, unknown>): EnvValidationError {
  try {
    parseEnv(raw);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('accepts a valid echo-mode configuration and applies defaults', () => {
    const env = parseEnv(validEnv());

    expect(env).toMatchObject({
      PORT: 3000,
      NODE_ENV: 'development',
      BOT_REPLY_MODE: 'echo',
      WHATSAPP_HTTP_TIMEOUT_MS: 10_000,
      AI_MAX_INTERACTIONS_PER_USER_PER_DAY: 30,
      OPENAI_TIMEOUT_MS: 20_000,
      OPENAI_MAX_OUTPUT_TOKENS: 300,
      AI_HISTORY_LIMIT: 12,
      JOB_MAX_ATTEMPTS: 4,
      WORKER_ENABLED: true,
      QUEUE_POLL_INTERVAL_MS: 1_000,
      QUEUE_IDLE_POLL_INTERVAL_MS: 600_000,
      QUEUE_CONCURRENCY: 2,
      QUEUE_LEASE_MS: 120_000,
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL_UNPOOLED).toBeUndefined();
  });

  it('coerces numeric variables from strings', () => {
    const env = parseEnv(
      validEnv({ PORT: '8080', AI_MAX_INTERACTIONS_PER_USER_PER_DAY: '5' }),
    );

    expect(env.PORT).toBe(8080);
    expect(env.AI_MAX_INTERACTIONS_PER_USER_PER_DAY).toBe(5);
  });

  it.each([
    'DATABASE_URL',
    'META_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_GRAPH_API_VERSION',
    'ADMIN_API_KEY',
  ])('rejects a missing %s', (key) => {
    const error = captureError(validEnv({ [key]: undefined }));

    expect(error.problems).toContainEqual(expect.stringContaining(key));
  });

  it('rejects an empty required value', () => {
    const error = captureError(validEnv({ META_APP_SECRET: '   ' }));

    expect(error.problems).toEqual([
      'META_APP_SECRET: META_APP_SECRET is required',
    ]);
  });

  it.each(['26.0', 'v26', 'v26.0.1', 'latest'])(
    'rejects graph api version %s',
    (version) => {
      const error = captureError(
        validEnv({ WHATSAPP_GRAPH_API_VERSION: version }),
      );

      expect(error.problems).toEqual([
        'WHATSAPP_GRAPH_API_VERSION: WHATSAPP_GRAPH_API_VERSION must look like v26.0',
      ]);
    },
  );

  it('rejects an admin api key shorter than 32 characters', () => {
    const error = captureError(validEnv({ ADMIN_API_KEY: 'short-key' }));

    expect(error.problems).toEqual([
      'ADMIN_API_KEY: ADMIN_API_KEY must be at least 32 characters',
    ]);
  });

  it('rejects an unknown bot reply mode', () => {
    const error = captureError(validEnv({ BOT_REPLY_MODE: 'gpt' }));

    expect(error.problems).toEqual([
      'BOT_REPLY_MODE: BOT_REPLY_MODE must be "echo" or "ai"',
    ]);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects a non positive-integer daily cap (%s)',
    (value) => {
      const error = captureError(
        validEnv({ AI_MAX_INTERACTIONS_PER_USER_PER_DAY: value }),
      );

      expect(error.problems[0]).toMatch(
        /^AI_MAX_INTERACTIONS_PER_USER_PER_DAY: /,
      );
    },
  );

  it('parses WORKER_ENABLED=false and queue tuning values', () => {
    const env = parseEnv(
      validEnv({
        WORKER_ENABLED: 'false',
        QUEUE_POLL_INTERVAL_MS: '250',
        QUEUE_IDLE_POLL_INTERVAL_MS: '30000',
        QUEUE_CONCURRENCY: '4',
        QUEUE_LEASE_MS: '60000',
      }),
    );

    expect(env).toMatchObject({
      WORKER_ENABLED: false,
      QUEUE_POLL_INTERVAL_MS: 250,
      QUEUE_IDLE_POLL_INTERVAL_MS: 30_000,
      QUEUE_CONCURRENCY: 4,
      QUEUE_LEASE_MS: 60_000,
    });
  });

  it('rejects an invalid WORKER_ENABLED value', () => {
    const error = captureError(validEnv({ WORKER_ENABLED: 'yes' }));

    expect(error.problems).toEqual([
      'WORKER_ENABLED: WORKER_ENABLED must be "true" or "false"',
    ]);
  });

  it.each([
    'QUEUE_POLL_INTERVAL_MS',
    'QUEUE_IDLE_POLL_INTERVAL_MS',
    'QUEUE_CONCURRENCY',
    'QUEUE_LEASE_MS',
  ])('rejects a non positive %s', (key) => {
    const error = captureError(validEnv({ [key]: '0' }));

    expect(error.problems).toEqual([`${key}: ${key} must be greater than 0`]);
  });

  it('rejects a non-postgres database url', () => {
    const error = captureError(validEnv({ DATABASE_URL: 'mysql://x@y/z' }));

    expect(error.problems).toEqual([
      'DATABASE_URL: DATABASE_URL must be a postgresql:// connection string',
    ]);
  });

  it('accepts a direct database url for migrations', () => {
    const env = parseEnv(
      validEnv({ DATABASE_URL_UNPOOLED: 'postgresql://u:p@direct.host/db' }),
    );

    expect(env.DATABASE_URL_UNPOOLED).toBe('postgresql://u:p@direct.host/db');
  });

  it('rejects a non-postgres direct database url', () => {
    const error = captureError(
      validEnv({ DATABASE_URL_UNPOOLED: 'mysql://x@y/z' }),
    );

    expect(error.problems).toEqual([
      'DATABASE_URL_UNPOOLED: DATABASE_URL_UNPOOLED must be a postgresql:// connection string',
    ]);
  });

  describe('when BOT_REPLY_MODE=ai', () => {
    it('requires OPENAI_API_KEY and OPENAI_MODEL', () => {
      const error = captureError(validEnv({ BOT_REPLY_MODE: 'ai' }));

      expect(error.problems).toEqual([
        'OPENAI_API_KEY: OPENAI_API_KEY is required when BOT_REPLY_MODE=ai',
        'OPENAI_MODEL: OPENAI_MODEL is required when BOT_REPLY_MODE=ai',
      ]);
    });

    it('accepts the configuration once both OpenAI variables are set', () => {
      const env = parseEnv(
        validEnv({
          BOT_REPLY_MODE: 'ai',
          OPENAI_API_KEY: SECRETS.OPENAI_API_KEY,
          OPENAI_MODEL: 'some-model-id',
        }),
      );

      expect(env.BOT_REPLY_MODE).toBe('ai');
      expect(env.OPENAI_MODEL).toBe('some-model-id');
    });

    it('rejects a queue lease shorter than the worst-case AI job', () => {
      const ai = {
        BOT_REPLY_MODE: 'ai',
        OPENAI_API_KEY: SECRETS.OPENAI_API_KEY,
        OPENAI_MODEL: 'some-model-id',
      };
      const error = captureError(validEnv({ ...ai, QUEUE_LEASE_MS: '60000' }));

      expect(error.problems).toEqual([
        expect.stringMatching(
          /^QUEUE_LEASE_MS: QUEUE_LEASE_MS must be greater than 80000/,
        ),
      ]);
      // The same lease is fine in echo mode (no model calls).
      expect(
        parseEnv(validEnv({ QUEUE_LEASE_MS: '60000' })).QUEUE_LEASE_MS,
      ).toBe(60_000);
    });
  });

  it('reports every problem without including any provided value', () => {
    const raw = validEnv({
      BOT_REPLY_MODE: 'ai',
      OPENAI_API_KEY: SECRETS.OPENAI_API_KEY,
      ADMIN_API_KEY: 'tiny-secret-admin-value',
      WHATSAPP_GRAPH_API_VERSION: 'secret-looking-version',
      DATABASE_URL: 'mysql://user:db-password-never-leak@host/db',
      PORT: 'not-a-port-secret',
    });

    const error = captureError(raw);

    expect(error.problems.length).toBeGreaterThanOrEqual(5);
    const output = `${error.message}\n${error.stack ?? ''}`;
    const providedValues = [
      ...Object.values(SECRETS),
      'tiny-secret-admin-value',
      'secret-looking-version',
      'db-password-never-leak',
      'not-a-port-secret',
    ];
    for (const value of providedValues) {
      expect(output).not.toContain(value);
    }
  });
});
