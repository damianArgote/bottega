import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/**
 * Verifies Meta's `X-Hub-Signature-256` header: `sha256=<hex>` where hex is
 * the HMAC-SHA256 of the exact raw request body bytes keyed with the app
 * secret. Returns false for a missing body, a missing or malformed header,
 * or a mismatch. Comparison is constant-time.
 */
export function isValidSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!rawBody || !header) {
    return false;
  }
  const match = SIGNATURE_PATTERN.exec(header.trim());
  if (!match?.[1]) {
    return false;
  }
  const received = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/** Builds a header value; used by tests and local tooling. */
export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
