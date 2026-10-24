import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

/**
 * In-process "new job enqueued" notification. Lets the worker pick a job up
 * right away instead of waiting for its next (possibly long, idle) poll.
 * It is only a hint: the queue table stays the source of truth, so a lost
 * signal just delays a job until the next poll.
 */
@Injectable()
export class QueueSignal {
  private readonly enqueued = new Subject<void>();

  /** Call after the transaction that inserted the job has committed. */
  notifyEnqueued(): void {
    this.enqueued.next();
  }

  get enqueued$(): Observable<void> {
    return this.enqueued.asObservable();
  }
}
