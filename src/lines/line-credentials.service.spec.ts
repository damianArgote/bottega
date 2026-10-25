import { randomBytes } from 'node:crypto';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Env } from '../config/env.schema.js';
import { LineCredentialsService } from './line-credentials.service.js';

const configWith = (key: string) =>
  ({
    get: (name: keyof Env) =>
      name === 'TOKEN_ENCRYPTION_KEY' ? key : undefined,
  }) as unknown as AppConfigService;

describe('LineCredentialsService', () => {
  it('decrypts what it encrypted with TOKEN_ENCRYPTION_KEY', () => {
    const service = new LineCredentialsService(
      configWith(randomBytes(32).toString('base64')),
    );

    expect(service.decrypt(service.encrypt('app-secret'))).toBe('app-secret');
  });

  it('cannot read credentials encrypted under another key', () => {
    const a = new LineCredentialsService(
      configWith(randomBytes(32).toString('base64')),
    );
    const b = new LineCredentialsService(
      configWith(randomBytes(32).toString('base64')),
    );

    expect(() => b.decrypt(a.encrypt('app-secret'))).toThrow(
      'Could not decrypt credential',
    );
  });
});
