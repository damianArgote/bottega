export interface PollDelayInput {
  /** True when the last round claimed at least one job, or a job is still running. */
  busy: boolean;
  /**
   * Earliest moment a waiting job becomes claimable (a future `run_after` or
   * an expiring lease), or null when the queue has nothing left to run.
   */
  nextRunnableAt: Date | null;
  now: Date;
  pollIntervalMs: number;
  idlePollIntervalMs: number;
}

/**
 * How long the worker waits before its next poll.
 *
 * - Busy: keep the regular pace (`pollIntervalMs`).
 * - Idle: sleep `idlePollIntervalMs` so the database can scale to zero,
 *   but wake up earlier when a retry or an expiring lease is due. Never
 *   sooner than `pollIntervalMs`: a job that is due but blocked behind
 *   another job of its conversation must not turn the wait into a busy loop.
 */
export function pollDelayMs(input: PollDelayInput): number {
  const { busy, nextRunnableAt, now, pollIntervalMs, idlePollIntervalMs } =
    input;
  if (busy) {
    return pollIntervalMs;
  }
  const idle = Math.max(pollIntervalMs, idlePollIntervalMs);
  if (!nextRunnableAt) {
    return idle;
  }
  const untilDue = nextRunnableAt.getTime() - now.getTime();
  return Math.min(idle, Math.max(pollIntervalMs, untilDue));
}
