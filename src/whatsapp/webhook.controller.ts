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
import { InboundDispatcher } from './inbound.dispatcher.js';
import { parseWebhookPayload } from './payload.parser.js';
import { WhatsAppSignatureGuard } from './signature.guard.js';

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly dispatcher: InboundDispatcher,
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
   * Event delivery. The signature guard runs first; processing is handed to
   * the dispatcher without awaiting so Meta gets a fast 200.
   */
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @UseGuards(WhatsAppSignatureGuard)
  receive(@Body() payload: unknown): string {
    const events = parseWebhookPayload(payload, {
      phoneNumberId: this.config.get('WHATSAPP_PHONE_NUMBER_ID'),
    });
    this.dispatcher.accept(events);
    return 'EVENT_RECEIVED';
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
