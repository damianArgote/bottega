import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/int/database-url.js';

// Integration suite: real PostgreSQL (database `bottega_test`, created and
// migrated by the global setup). Meta and OpenAI are still mocked.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/int/**/*.int-spec.ts'],
    globalSetup: ['test/int/global-setup.ts'],
    setupFiles: ['test/int/silence-logs.ts'],
    // Files share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      META_APP_SECRET: 'int-meta-app-secret',
      WHATSAPP_VERIFY_TOKEN: 'int-verify-token',
      WHATSAPP_ACCESS_TOKEN: 'int-access-token',
      WHATSAPP_PHONE_NUMBER_ID: '000000000000000',
      WHATSAPP_GRAPH_API_VERSION: 'v26.0',
      BOT_REPLY_MODE: 'echo',
      ADMIN_API_KEY: 'int-admin-api-key-0123456789abcdef',
      // 32 zero bytes, base64: test-only.
      TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      JWT_SECRET: 'int-jwt-secret-0123456789abcdef0123456789',
      INBOX_ORIGIN: 'https://inbox.test',
      // Tests drive the worker by hand (BotWorker.processNext / drain).
      WORKER_ENABLED: 'false',
      JOB_MAX_ATTEMPTS: '3',
    },
  },
});
