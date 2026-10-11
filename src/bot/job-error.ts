/**
 * Failure raised while processing a job. `code` is a short static label
 * (stored as the job's `last_error`); `retryable` decides whether the queue
 * schedules another attempt. Errors of any other type count as retryable.
 */
export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'JobError';
  }
}
