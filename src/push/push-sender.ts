import webpush, { WebPushError } from 'web-push';
import type { VapidDetails } from './push-config.js';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushOptions {
  /** Seconds the push service keeps it for an offline browser. */
  ttl: number;
  /** Up to 32 URL-safe base64 characters: replaces a pending push with it. */
  topic: string;
}

/**
 * accepted: the push service took it. gone: the subscription no longer
 * exists (404/410), delete it. failed: anything else, worth a retry.
 */
export type PushOutcome =
  | { kind: 'accepted' }
  | { kind: 'gone' }
  | { kind: 'failed'; statusCode: number | null };

/** Sends one encrypted Web Push message. Never throws. */
export interface PushSender {
  send(
    target: PushTarget,
    payload: string,
    options: PushOptions,
  ): Promise<PushOutcome>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

const SEND_TIMEOUT_MS = 10_000;

/** PushSender over the `web-push` library (VAPID, aes128gcm). */
export class WebPushSender implements PushSender {
  constructor(private readonly vapid: VapidDetails) {}

  async send(
    target: PushTarget,
    payload: string,
    options: PushOptions,
  ): Promise<PushOutcome> {
    try {
      await webpush.sendNotification(target, payload, {
        vapidDetails: this.vapid,
        TTL: options.ttl,
        topic: options.topic,
        urgency: 'high',
        timeout: SEND_TIMEOUT_MS,
      });
      return { kind: 'accepted' };
    } catch (error) {
      const statusCode =
        error instanceof WebPushError ? error.statusCode : null;
      return statusCode === 404 || statusCode === 410
        ? { kind: 'gone' }
        : { kind: 'failed', statusCode };
    }
  }
}
