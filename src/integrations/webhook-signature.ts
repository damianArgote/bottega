import { createHmac } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-Bottega-Signature';
export const TIMESTAMP_HEADER = 'X-Bottega-Timestamp';

/**
 * `sha256=<hex>` of HMAC-SHA256(secret, `${timestamp}.${body}`), with the
 * timestamp in Unix seconds (sent in X-Bottega-Timestamp). The receiver
 * recomputes it over the raw body and rejects old timestamps (replays).
 */
export function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `sha256=${mac}`;
}
