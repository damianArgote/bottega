import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { CredentialsCipher } from './credentials-cipher.js';

/**
 * Encrypts and decrypts per-line Meta credentials with TOKEN_ENCRYPTION_KEY.
 * Decrypted values must never be returned by the API or logged.
 */
@Injectable()
export class LineCredentialsService {
  private readonly cipher: CredentialsCipher;

  constructor(config: AppConfigService) {
    this.cipher = new CredentialsCipher(
      Buffer.from(config.get('TOKEN_ENCRYPTION_KEY'), 'base64'),
    );
  }

  encrypt(plaintext: string): string {
    return this.cipher.encrypt(plaintext);
  }

  /** Throws CredentialsDecryptError when the value cannot be decrypted. */
  decrypt(encrypted: string): string {
    return this.cipher.decrypt(encrypted);
  }
}
