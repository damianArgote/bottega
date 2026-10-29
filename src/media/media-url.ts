import { createHmac, timingSafeEqual } from 'node:crypto';

const WINDOW_MS = 30 * 60_000;

/**
 * When a link signed at `now` expires (Unix seconds): the start of the
 * current half hour plus 90 minutes. Every link handed out in the same half
 * hour is identical (the inbox polling does not change an <audio> source
 * and cut it), and each lives between 60 and 90 minutes.
 */
export function mediaUrlExpiry(now: Date): number {
  const windowStart = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  return Math.floor((windowStart + 3 * WINDOW_MS) / 1000);
}

function signature(
  secret: string,
  businessId: string,
  messageId: string,
  exp: number,
): Buffer {
  return createHmac('sha256', secret)
    .update(`${businessId}:${messageId}:${exp}`)
    .digest();
}

/**
 * The inbox's link to an attachment: signed (HMAC-SHA256 over business,
 * message and expiry), so the proxy needs no session cookie.
 */
export function signedMediaPath(
  secret: string,
  businessId: string,
  messageId: string,
  now = new Date(),
): string {
  const exp = mediaUrlExpiry(now);
  const sig = signature(secret, businessId, messageId, exp).toString(
    'base64url',
  );
  return `/inbox/businesses/${businessId}/media/${messageId}?exp=${exp}&sig=${sig}`;
}

/** True when the signature matches (constant time) and has not expired. */
export function verifyMediaSignature(
  secret: string,
  businessId: string,
  messageId: string,
  exp: string | undefined,
  sig: string | undefined,
  now = new Date(),
): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) {
    return false;
  }
  const expiry = Number(exp);
  if (expiry * 1000 <= now.getTime()) {
    return false;
  }
  const expected = signature(secret, businessId, messageId, expiry);
  const given = Buffer.from(sig, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
