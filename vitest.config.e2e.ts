import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Native tsconfig `paths` resolution (no plugin needed).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // Dummy, non-secret values so the real env validation passes in e2e runs.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://e2e:e2e@localhost:5432/e2e',
      META_APP_SECRET: 'e2e-meta-app-secret',
      WHATSAPP_VERIFY_TOKEN: 'e2e-verify-token',
      WHATSAPP_ACCESS_TOKEN: 'e2e-access-token',
      WHATSAPP_PHONE_NUMBER_ID: '000000000000000',
      WHATSAPP_GRAPH_API_VERSION: 'v26.0',
      BOT_REPLY_MODE: 'echo',
      ADMIN_API_KEY: 'e2e-admin-api-key-0123456789abcdef',
      // 32 zero bytes, base64: test-only.
      TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef0123456789',
      MEDIA_URL_SECRET: 'e2e-media-secret-0123456789abcdef01234567',
      INBOX_ORIGIN: 'https://inbox.test',
      // The queue worker would poll the (mocked) database; e2e is HTTP-only.
      WORKER_ENABLED: 'false',
    },
  },
});
