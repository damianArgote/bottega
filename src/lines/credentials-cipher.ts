import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
// 96-bit IV, the size GCM is designed for.
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/**
 * Thrown when a stored credential cannot be decrypted (wrong key, tampered
 * or malformed value). The message never includes the value.
 */
export class CredentialsDecryptError extends Error {
  constructor(reason: string) {
    super(`Could not decrypt credential: ${reason}`);
    this.name = 'CredentialsDecryptError';
  }
}

/**
 * AES-256-GCM encryption for credentials stored at rest (per-line Meta app
 * secret and access token). Output format: `v1.<iv>.<tag>.<ciphertext>`,
 * each part base64url. The version prefix leaves room for key rotation.
 */
export class CredentialsCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const data = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, data]
      .map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      )
      .join('.');
  }

  decrypt(value: string): string {
    const [version, ivPart, tagPart, dataPart, ...rest] = value.split('.');
    if (
      version !== VERSION ||
      ivPart === undefined ||
      tagPart === undefined ||
      dataPart === undefined ||
      rest.length > 0
    ) {
      throw new CredentialsDecryptError('unknown format');
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const data = Buffer.from(dataPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CredentialsDecryptError('unknown format');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      // GCM authentication failed: wrong key or tampered value.
      throw new CredentialsDecryptError('authentication failed');
    }
  }
}
