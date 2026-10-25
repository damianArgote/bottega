import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** Password hashing with argon2id (the library's recommended parameters). */
@Injectable()
export class PasswordHasher {
  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /** False for a wrong password or a malformed hash; never throws for those. */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
