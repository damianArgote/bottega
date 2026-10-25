import { Injectable, Logger } from '@nestjs/common';
import {
  ConversationsService,
  type RoutedLine,
} from '../conversations/conversations.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { LinesService } from '../lines/lines.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UTC_NOW } from '../prisma/sql.js';
import { sanitizeError } from '../queue/queue.service.js';
import { parseWebhookPayload } from './payload.parser.js';

/** The stored event's line no longer exists, or no default line is seeded. */
export class WebhookLineMissingError extends Error {
  override name = 'WebhookLineMissingError';
}

/**
 * Processes one stored webhook event: resolves its line, parses the payload
 * and ingests the events. Success marks it processed; a failure records a
 * content-free error and leaves it pending. Safe to repeat: inbound messages
 * are deduplicated by wamid and statuses only move forward.
 */
@Injectable()
export class WebhookEventProcessor {
  private readonly logger = new Logger(WebhookEventProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lines: LinesService,
    private readonly conversations: ConversationsService,
  ) {}

  /** Returns true when the event ended processed. Never throws. */
  async process(eventId: bigint): Promise<boolean> {
    try {
      const event = await this.prisma.webhookEvent.findUnique({
        where: { id: eventId },
        select: { lineId: true, payload: true, processedAt: true },
      });
      if (!event || event.processedAt) {
        return true;
      }
      const line = await this.resolveLine(event.lineId);
      await this.conversations.ingest(parseWebhookPayload(event.payload), line);
      await this.prisma.$executeRaw`
        UPDATE webhook_event
        SET processed_at = ${UTC_NOW}, attempts = attempts + 1, error = NULL
        WHERE id = ${eventId}`;
      return true;
    } catch (error) {
      await this.recordFailure(eventId, error);
      return false;
    }
  }

  private async resolveLine(lineId: string | null): Promise<RoutedLine> {
    if (lineId) {
      const line = await this.lines.findById(lineId);
      if (line) {
        return {
          lineId: line.id,
          businessId: line.businessId,
          phoneNumberId: line.phoneNumberId,
        };
      }
    } else {
      const line = await this.conversations.defaultLine();
      if (line) {
        return line;
      }
    }
    throw new WebhookLineMissingError();
  }

  private async recordFailure(eventId: bigint, error: unknown): Promise<void> {
    const label = sanitizeError(error);
    this.logger.warn(`Webhook event ${eventId} left pending (${label})`);
    try {
      await this.prisma.$executeRaw`
        UPDATE webhook_event
        SET attempts = attempts + 1, error = ${label}
        WHERE id = ${eventId} AND processed_at IS NULL`;
    } catch (updateError) {
      // Database down: the event keeps its previous attempt count and is
      // still picked up by the reprocessor.
      this.logger.error(
        `Could not record the failure of webhook event ${eventId} (${sanitizeError(updateError)})`,
      );
    }
  }

  /** Stores a verified delivery. Throws when the database is unavailable. */
  async store(payload: unknown, lineId: string | null): Promise<bigint> {
    const event = await this.prisma.webhookEvent.create({
      data: { lineId, payload: payload as Prisma.InputJsonValue },
      select: { id: true },
    });
    return event.id;
  }
}
