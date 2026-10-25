import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Short-lived session JWTs (HS256, `sub` = user id) signed with JWT_SECRET. */
export class SessionTokens {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  sign(userId: string, now = new Date()): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + SESSION_TTL_SECONDS)
      .sign(this.key);
  }

  /** The user id, or null for an invalid, tampered or expired token. */
  async verify(token: string, now = new Date()): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        currentDate: now,
      });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

/** 32 random bytes, base64url: the refresh token handed to the browser. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored for a refresh token: its SHA-256, hex. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
