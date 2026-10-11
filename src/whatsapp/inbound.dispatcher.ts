import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { echoReply, UNSUPPORTED_REPLY } from './echo-replies.js';
import type { InboundEvent } from './inbound-event.js';
import { RecentIds } from './recent-ids.js';
import {
  maskPhone,
  WHATSAPP_CLIENT,
  type WhatsAppClient,
} from './whatsapp.client.js';

/**
 * Handles parsed webhook events outside the HTTP request cycle.
 *
 * Stage 2 (temporary): replies directly (echo mode) with in-memory dedupe.
 * Stage 3 swaps `accept` for "persist + enqueue" (DB dedupe via unique
 * constraint, PG job queue, worker sends); the controller contract
 * (`accept(events)`) stays the same.
 */
@Injectable()
export class InboundDispatcher implements OnApplicationShutdown {
  private readonly logger = new Logger(InboundDispatcher.name);
  private readonly seen = new RecentIds();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfigService,
    @Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClient,
  ) {}

  /**
   * Schedules processing on a later macrotask and returns immediately, so the
   * webhook can answer 200 before any sending happens. Never throws.
   */
  accept(events: readonly InboundEvent[]): void {
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.process(events))
      .catch((error: unknown) => {
        this.logger.error(`Inbound batch failed: ${errorName(error)}`);
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  /** Resolves once every accepted batch finished. Used by tests and shutdown. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.whenIdle();
  }

  private async process(events: readonly InboundEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.handle(event);
      } catch (error) {
        this.logger.error(`Inbound event failed: ${errorName(error)}`);
      }
    }
  }

  private async handle(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case 'ignored':
        this.logger.debug(`Ignored webhook item: ${event.reason}`);
        return;
      case 'status':
        this.logger.debug(
          `Status ${event.status} for outbound message to ${maskPhone(event.recipientId)}${
            event.errors?.length
              ? ` (error codes: ${event.errors.map((e) => e.code).join(',')})`
              : ''
          }`,
        );
        return;
      case 'text':
      case 'unsupported':
        break;
    }

    if (!this.seen.add(event.waMessageId)) {
      this.logger.log(
        `Duplicate delivery skipped for message from ${maskPhone(event.from)}`,
      );
      return;
    }
    this.logger.log(
      `Inbound ${event.kind === 'text' ? 'text' : event.messageType} message from ${maskPhone(event.from)}`,
    );

    if (this.config.get('BOT_REPLY_MODE') === 'ai') {
      this.logger.warn(
        'BOT_REPLY_MODE=ai is not implemented yet; inbound message left unanswered',
      );
      return;
    }

    const reply =
      event.kind === 'text' ? echoReply(event.text) : UNSUPPORTED_REPLY;
    await this.client.sendText(event.from, reply);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
