/**
 * What a Meta (Graph) error code means for us, in one place:
 * - window_closed (131047): the 24 h customer service window is closed;
 *   the inbox moves the conversation's window to now.
 * - undeliverable (131026): the number cannot receive the message.
 * - rate_limited: not accepted now, try later (4 app rate limit, 80007 WABA
 *   rate limit, 130429 throughput, 131056 pair rate, 131048 spam rate
 *   limit, 131049 ecosystem limit).
 * Timeouts and 5xx never get here: the client reports them as uncertain
 * (never retried).
 */
export type MetaErrorKind =
  'window_closed' | 'undeliverable' | 'rate_limited' | 'other';

const KINDS = new Map<number, MetaErrorKind>([
  [131047, 'window_closed'],
  [131026, 'undeliverable'],
  ...[4, 80007, 130429, 131056, 131048, 131049].map(
    (code) => [code, 'rate_limited'] as const,
  ),
]);

export function metaErrorKind(code: number | string): MetaErrorKind {
  return (typeof code === 'number' && KINDS.get(code)) || 'other';
}
