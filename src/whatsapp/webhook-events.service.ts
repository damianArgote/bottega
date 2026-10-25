import { Injectable } from '@nestjs/common';
import { WebhookEventProcessor } from './webhook-event-processor.js';
import { WebhookReprocessor } from './webhook-reprocessor.js';

/**
 * Entry point for verified webhook deliveries: stores the raw event, then
 * processes it right away. Only storing can fail the request (so Meta
 * redelivers); a processing failure leaves the event pending and asks the
 * reprocessor to retry it.
 */
@Injectable()
export class WebhookEventsService {
  constructor(
    private readonly processor: WebhookEventProcessor,
    private readonly reprocessor: WebhookReprocessor,
  ) {}

  async receive(payload: unknown, lineId: string | null): Promise<void> {
    const eventId = await this.processor.store(payload, lineId);
    if (!(await this.processor.process(eventId))) {
      this.reprocessor.schedule();
    }
  }
}
