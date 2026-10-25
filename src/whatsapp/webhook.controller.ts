import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { LinesService } from '../lines/lines.service.js';
import {
  LineSignatureGuard,
  type LineRequest,
} from './line-signature.guard.js';
import { WhatsAppSignatureGuard } from './signature.guard.js';
import { WebhookEventsService } from './webhook-events.service.js';

/**
 * Meta webhooks. `/webhooks/whatsapp/:webhookKey` serves one line with its
 * own app secret and verify token; the keyless `/webhooks/whatsapp` serves
 * the default line configured in the environment.
 *
 * Deliveries are stored before answering 200 and processed right away; a
 * processing failure stays pending for the reprocessor. Only a failure to
 * store answers 5xx, so Meta redelivers (dedupe makes it safe).
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly lines: LinesService,
    private readonly events: WebhookEventsService,
  ) {}

  /** Meta subscription handshake for the default line. */
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') token: unknown,
    @Query('hub.challenge') challenge: unknown,
  ): string {
    const verifyToken = this.config.get('WHATSAPP_VERIFY_TOKEN');
    if (!verifyToken) {
      throw new NotFoundException();
    }
    return this.handshake(mode, token, challenge, verifyToken);
  }

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @UseGuards(WhatsAppSignatureGuard)
  async receive(@Body() payload: unknown): Promise<string> {
    await this.events.receive(payload, null);
    return 'EVENT_RECEIVED';
  }

  /** Meta subscription handshake for one line. */
  @Get(':webhookKey')
  @Header('Content-Type', 'text/plain')
  async verifyLine(
    @Param('webhookKey') webhookKey: string,
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') token: unknown,
    @Query('hub.challenge') challenge: unknown,
  ): Promise<string> {
    const line = await this.lines.findByWebhookKey(webhookKey);
    if (!line || !line.active) {
      throw new NotFoundException();
    }
    return this.handshake(mode, token, challenge, line.verifyToken);
  }

  @Post(':webhookKey')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @UseGuards(LineSignatureGuard)
  async receiveLine(
    @Req() request: LineRequest,
    @Body() payload: unknown,
  ): Promise<string> {
    // Set by LineSignatureGuard, which rejects the request otherwise.
    await this.events.receive(payload, request.webhookLine!.id);
    return 'EVENT_RECEIVED';
  }

  /** Echoes `hub.challenge` when the token matches. */
  private handshake(
    mode: unknown,
    token: unknown,
    challenge: unknown,
    expected: string,
  ): string {
    if (
      mode !== 'subscribe' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      challenge.length === 0 ||
      !safeEqual(token, expected)
    ) {
      this.logger.warn('Webhook verification rejected');
      throw new ForbiddenException();
    }
    this.logger.log('Webhook verification accepted');
    return challenge;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
