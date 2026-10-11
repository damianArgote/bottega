import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { parseWebhookPayload } from './payload.parser.js';
import { WhatsAppSignatureGuard } from './signature.guard.js';

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly conversations: ConversationsService,
  ) {}

  /** Meta subscription handshake: echo `hub.challenge` when the token matches. */
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') token: unknown,
    @Query('hub.challenge') challenge: unknown,
  ): string {
    if (
      mode !== 'subscribe' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      challenge.length === 0 ||
      !safeEqual(token, this.config.get('WHATSAPP_VERIFY_TOKEN'))
    ) {
      this.logger.warn('Webhook verification rejected');
      throw new ForbiddenException();
    }
    this.logger.log('Webhook verification accepted');
    return challenge;
  }

  /**
   * Event delivery. The signature guard runs first. Events are persisted
   * (messages + their jobs) before answering 200; replies are sent later by
   * the queue worker. A persistence failure surfaces as 5xx so Meta retries;
   * retries are safe because inbound messages are deduplicated by wamid.
   */
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @UseGuards(WhatsAppSignatureGuard)
  async receive(@Body() payload: unknown): Promise<string> {
    const events = parseWebhookPayload(payload, {
      phoneNumberId: this.config.get('WHATSAPP_PHONE_NUMBER_ID'),
    });
    await this.conversations.ingest(events);
    return 'EVENT_RECEIVED';
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
