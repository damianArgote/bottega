import { Test } from '@nestjs/testing';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  WHATSAPP_GRAPH_API_VERSION: 'v26.0',
  ADMIN_API_KEY: 'unit-admin-api-key-0123456789abcdef',
  TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

/**
 * Boots the real AppConfigModule with `env` as process.env. The module reads
 * the environment when it is imported, so it is imported fresh each time.
 */
async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const { AppConfigModule } = await import('./app-config.module.js');
  const { AppConfigService } = await import('./app-config.service.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule],
  }).compile();
  return moduleRef.get(AppConfigService);
}

describe('AppConfigService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns validated values', async () => {
    const config = await configWith({ ...VALID_ENV, PORT: '8080' });

    expect(config.get('PORT')).toBe(8080);
    expect(config.get('WORKER_ENABLED')).toBe(true);
  });

  it.each([
    'META_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
  ] as const)(
    'returns undefined for a blank %s instead of the raw environment value',
    async (key) => {
      const config = await configWith({ ...VALID_ENV, [key]: '   ' });

      expect(config.get(key)).toBeUndefined();
    },
  );
});
