import { EnvValidationError, parseEnv } from './env.schema.js';

const SECRETS = {
  META_APP_SECRET: 'meta-secret-value-should-never-leak',
  WHATSAPP_VERIFY_TOKEN: 'verify-token-value-should-never-leak',
  WHATSAPP_ACCESS_TOKEN: 'access-token-value-should-never-leak',
  OPENAI_API_KEY: 'sk-openai-value-should-never-leak',
  ADMIN_API_KEY: 'admin-key-value-should-never-leak-0123456789',
  // 32 random bytes, base64.
  TOKEN_ENCRYPTION_KEY: 'Q2xhdmVEZVBydWViYU5vVXNhckVuUHJvZHVjY2lvbiE=',
  JWT_SECRET: 'jwt-secret-value-should-never-leak-0123456789',
  MEDIA_URL_SECRET: 'media-secret-value-should-never-leak-0123456',
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
    TOKEN_ENCRYPTION_KEY: SECRETS.TOKEN_ENCRYPTION_KEY,
    JWT_SECRET: SECRETS.JWT_SECRET,
    MEDIA_URL_SECRET: SECRETS.MEDIA_URL_SECRET,
    INBOX_ORIGIN: 'https://inbox.example.com',
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
      AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH: 5_000,
      CATALOG_MAX_ITEMS_PER_BUSINESS: 2_000,
      OPENAI_TIMEOUT_MS: 20_000,
      OPENAI_MAX_OUTPUT_TOKENS: 300,
      AI_HISTORY_LIMIT: 12,
      JOB_MAX_ATTEMPTS: 4,
      WORKER_ENABLED: true,
      QUEUE_POLL_INTERVAL_MS: 1_000,
      QUEUE_IDLE_POLL_INTERVAL_MS: 600_000,
      QUEUE_CONCURRENCY: 2,
      QUEUE_LEASE_MS: 180_000,
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

  it('starts without the default line Meta variables', () => {
    const env = parseEnv(
      validEnv({
        META_APP_SECRET: undefined,
        WHATSAPP_VERIFY_TOKEN: undefined,
        WHATSAPP_ACCESS_TOKEN: undefined,
        WHATSAPP_PHONE_NUMBER_ID: undefined,
      }),
    );

    expect(env.META_APP_SECRET).toBeUndefined();
    expect(env.WHATSAPP_VERIFY_TOKEN).toBeUndefined();
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeUndefined();
    expect(env.WHATSAPP_PHONE_NUMBER_ID).toBeUndefined();
  });

  it.each([
    'META_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
  ])('treats a blank %s as not set', (key) => {
    const env = parseEnv(validEnv({ [key]: '   ' }));

    expect(env[key as keyof typeof env]).toBeUndefined();
  });

  it.each([
    'DATABASE_URL',
    'WHATSAPP_GRAPH_API_VERSION',
    'ADMIN_API_KEY',
    'TOKEN_ENCRYPTION_KEY',
    'JWT_SECRET',
    'MEDIA_URL_SECRET',
    'INBOX_ORIGIN',
  ])('rejects a missing %s', (key) => {
    const error = captureError(validEnv({ [key]: undefined }));

    expect(error.problems).toContainEqual(expect.stringContaining(key));
  });

  it('rejects an empty required value', () => {
    const error = captureError(validEnv({ ADMIN_API_KEY: '   ' }));

    expect(error.problems).toContain(
      'ADMIN_API_KEY: ADMIN_API_KEY is required',
    );
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

  it.each([
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['too long', Buffer.alloc(48, 1).toString('base64')],
    ['not base64', 'this is definitely not base64 at all!!!!!!!'],
  ])('rejects a TOKEN_ENCRYPTION_KEY that is %s', (_label, value) => {
    const error = captureError(validEnv({ TOKEN_ENCRYPTION_KEY: value }));

    expect(error.problems).toEqual([
      'TOKEN_ENCRYPTION_KEY: TOKEN_ENCRYPTION_KEY must be 32 bytes encoded in base64 (openssl rand -base64 32)',
    ]);
  });

  it('accepts a 32-byte base64 TOKEN_ENCRYPTION_KEY', () => {
    const env = parseEnv(validEnv());

    expect(Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64')).toHaveLength(32);
  });

  it('rejects an admin api key shorter than 32 characters', () => {
    const error = captureError(validEnv({ ADMIN_API_KEY: 'short-key' }));

    expect(error.problems).toEqual([
      'ADMIN_API_KEY: ADMIN_API_KEY must be at least 32 characters',
    ]);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    const error = captureError(validEnv({ JWT_SECRET: 'short-secret' }));

    expect(error.problems).toEqual([
      'JWT_SECRET: JWT_SECRET must be at least 32 characters',
    ]);
  });

  it('rejects a media URL secret shorter than 32 characters', () => {
    const error = captureError(validEnv({ MEDIA_URL_SECRET: 'short-secret' }));

    expect(error.problems).toEqual([
      'MEDIA_URL_SECRET: MEDIA_URL_SECRET must be at least 32 characters',
    ]);
  });

  it('applies the attachment and transcription defaults', () => {
    expect(parseEnv(validEnv())).toMatchObject({
      OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-mini-transcribe',
      OPENAI_TRANSCRIBE_TIMEOUT_MS: 30_000,
      MEDIA_AUDIO_MAX_SECONDS: 120,
      MEDIA_AUDIO_MAX_BYTES: 1_000_000,
      MEDIA_IMAGE_MAX_BYTES: 5_000_000,
      MEDIA_DOCUMENT_MAX_BYTES: 10_000_000,
      MEDIA_MAX_PER_CONVERSATION_PER_DAY: 10,
    });
  });

  it.each([
    'inbox.example.com',
    'https://inbox.example.com/',
    'https://inbox.example.com/app',
    'ftp://inbox.example.com',
  ])('rejects an INBOX_ORIGIN that is not an origin (%s)', (value) => {
    const error = captureError(validEnv({ INBOX_ORIGIN: value }));

    expect(error.problems).toEqual([
      'INBOX_ORIGIN: INBOX_ORIGIN must be an origin like https://inbox.example.com (scheme, host and optional port, no path)',
    ]);
  });

  it('lowercases INBOX_ORIGIN, as browsers send it', () => {
    expect(
      parseEnv(validEnv({ INBOX_ORIGIN: 'https://Inbox.BotSuite46.com' }))
        .INBOX_ORIGIN,
    ).toBe('https://inbox.botsuite46.com');
  });

  it('accepts a local INBOX_ORIGIN with a port', () => {
    expect(
      parseEnv(validEnv({ INBOX_ORIGIN: 'http://localhost:4200' }))
        .INBOX_ORIGIN,
    ).toBe('http://localhost:4200');
  });

  describe('Web Push (VAPID)', () => {
    // A throwaway pair, generated for these tests only.
    const vapid = {
      VAPID_PUBLIC_KEY:
        'BDWoHXwGd0A1EkmJifVYTn-LkoWyr7Vg38nBPQlPawo4WhgQY8qkSbl_mzslt4X7XlJpbO1EnPw6JVUsl7KRfdY',
      VAPID_PRIVATE_KEY: 'yPmYWYTyNgsNmDJWJwKd6DeTQ5JuM_IO5W7XSc9PYXw',
      VAPID_SUBJECT: 'mailto:hola@botsuite46.com',
    };

    it('is off when none of the three is set', () => {
      const env = parseEnv(validEnv());

      expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
      expect(env.VAPID_PRIVATE_KEY).toBeUndefined();
      expect(env.VAPID_SUBJECT).toBeUndefined();
    });

    it('accepts the three together (mailto or https subject)', () => {
      expect(parseEnv(validEnv(vapid))).toMatchObject(vapid);
      expect(
        parseEnv(
          validEnv({ ...vapid, VAPID_SUBJECT: 'https://botsuite46.com' }),
        ).VAPID_SUBJECT,
      ).toBe('https://botsuite46.com');
    });

    it.each([
      ['VAPID_PUBLIC_KEY'],
      ['VAPID_PRIVATE_KEY'],
      ['VAPID_SUBJECT'],
    ] as const)('does not start with only some of them (%s missing)', (key) => {
      const error = captureError(validEnv({ ...vapid, [key]: undefined }));

      expect(error.problems).toContain(
        `${key}: ${key} is required when another VAPID_* variable is set (set the three or none)`,
      );
      expect(error.message).not.toContain(vapid.VAPID_PRIVATE_KEY);
    });

    it('rejects malformed keys and subject without echoing them', () => {
      const error = captureError(
        validEnv({
          VAPID_PUBLIC_KEY: 'not-a-key',
          VAPID_PRIVATE_KEY: 'secret-private-value',
          VAPID_SUBJECT: 'hola@botsuite46.com',
        }),
      );

      expect(error.problems).toEqual(
        expect.arrayContaining([
          'VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY must be a P-256 public key in base64url (npx web-push generate-vapid-keys)',
          'VAPID_PRIVATE_KEY: VAPID_PRIVATE_KEY must be a P-256 private key in base64url (npx web-push generate-vapid-keys)',
          'VAPID_SUBJECT: VAPID_SUBJECT must be a mailto: or https: URL',
        ]),
      );
      expect(error.message).not.toContain('secret-private-value');
    });
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

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects a non positive-integer monthly cap (%s)',
    (value) => {
      const error = captureError(
        validEnv({ AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH: value }),
      );

      expect(error.problems[0]).toMatch(
        /^AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH: /,
      );
    },
  );

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects a non positive-integer catalog item cap (%s)',
    (value) => {
      const error = captureError(
        validEnv({ CATALOG_MAX_ITEMS_PER_BUSINESS: value }),
      );

      expect(error.problems[0]).toMatch(/^CATALOG_MAX_ITEMS_PER_BUSINESS: /);
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

  it('normalizes PUBLIC_BASE_URL without a trailing slash', () => {
    const env = parseEnv(
      validEnv({ PUBLIC_BASE_URL: 'https://bottega.example.com/' }),
    );

    expect(env.PUBLIC_BASE_URL).toBe('https://bottega.example.com');
  });

  it('rejects a PUBLIC_BASE_URL that is not an http(s) URL', () => {
    const error = captureError(validEnv({ PUBLIC_BASE_URL: 'bottega.com' }));

    expect(error.problems).toEqual([
      'PUBLIC_BASE_URL: PUBLIC_BASE_URL must be an http(s) URL',
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
          /^QUEUE_LEASE_MS: QUEUE_LEASE_MS must be greater than 130000/,
        ),
      ]);
      // The same lease is fine in echo mode (no model calls).
      expect(
        parseEnv(validEnv({ QUEUE_LEASE_MS: '60000' })).QUEUE_LEASE_MS,
      ).toBe(60_000);
      // The default lease covers the default AI job, transcription included.
      expect(parseEnv(validEnv(ai)).QUEUE_LEASE_MS).toBe(180_000);
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
