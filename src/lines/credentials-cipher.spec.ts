import { randomBytes } from 'node:crypto';
import {
  CredentialsCipher,
  CredentialsDecryptError,
} from './credentials-cipher.js';

const key = randomBytes(32);

describe('CredentialsCipher', () => {
  it('round-trips a secret', () => {
    const cipher = new CredentialsCipher(key);

    const encrypted = cipher.encrypt('EAAG-system-user-token');

    expect(cipher.decrypt(encrypted)).toBe('EAAG-system-user-token');
  });

  it('never contains the plaintext and uses a fresh IV each time', () => {
    const cipher = new CredentialsCipher(key);

    const first = cipher.encrypt('same-secret');
    const second = cipher.encrypt('same-secret');

    expect(first).not.toContain('same-secret');
    expect(first).not.toBe(second);
    expect(first.startsWith('v1.')).toBe(true);
  });

  it('rejects a value encrypted with another key', () => {
    const encrypted = new CredentialsCipher(randomBytes(32)).encrypt('secret');

    expect(() => new CredentialsCipher(key).decrypt(encrypted)).toThrow(
      CredentialsDecryptError,
    );
  });

  it('rejects a tampered ciphertext', () => {
    const cipher = new CredentialsCipher(key);
    const parts = cipher.encrypt('secret').split('.');
    const flipped = Buffer.from(parts[3] ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString('base64url');

    expect(() => cipher.decrypt(parts.join('.'))).toThrow(
      CredentialsDecryptError,
    );
  });

  it.each(['', 'not-encrypted', 'v2.a.b.c', 'v1.a.b'])(
    'rejects a malformed value %j',
    (value) => {
      expect(() => new CredentialsCipher(key).decrypt(value)).toThrow(
        CredentialsDecryptError,
      );
    },
  );

  it('does not put the secret or the ciphertext in the error message', () => {
    const encrypted = new CredentialsCipher(randomBytes(32)).encrypt(
      'super-secret-token',
    );

    let message = '';
    try {
      new CredentialsCipher(key).decrypt(encrypted);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('super-secret-token');
    expect(message).not.toContain(encrypted);
  });

  it('requires a 32-byte key', () => {
    expect(() => new CredentialsCipher(randomBytes(16))).toThrow(
      'TOKEN_ENCRYPTION_KEY must decode to 32 bytes',
    );
  });
});
