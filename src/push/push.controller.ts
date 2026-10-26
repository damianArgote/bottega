import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import type { SessionUser } from '../auth/auth.service.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { AppConfigService } from '../config/app-config.service.js';
import { vapidDetails } from './push-config.js';
import { PushSubscriptionsService } from './push-subscriptions.service.js';

/** base64url (padding allowed) of exactly `bytes` bytes. */
const base64urlKey = (bytes: number) =>
  z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+=*$/, 'must be base64url')
    .refine(
      (value) => Buffer.from(value, 'base64url').length === bytes,
      `must be ${bytes} bytes`,
    );
const endpointSchema = z
  .string()
  .max(2_048)
  .pipe(z.url({ protocol: /^https$/, error: 'must be an https URL' }));
const subscribeBodySchema = z
  .object({
    endpoint: endpointSchema,
    // A P-256 public key and a 16-byte secret: anything else never works.
    keys: z
      .object({ p256dh: base64urlKey(65), auth: base64urlKey(16) })
      .strict(),
    /** Sent by PushSubscription.toJSON(); not used. */
    expirationTime: z.number().nullable().optional(),
  })
  .strict();
const unsubscribeBodySchema = z.object({ endpoint: endpointSchema }).strict();

/**
 * Web Push subscriptions of the session's user (any inbox person). 404 on
 * every route while push is not configured.
 */
@Controller('inbox/push')
@UseGuards(SessionGuard)
export class PushController {
  constructor(
    private readonly config: AppConfigService,
    private readonly subscriptions: PushSubscriptionsService,
  ) {}

  /** The VAPID public key the browser subscribes with. */
  @Get('public-key')
  publicKey() {
    return { publicKey: this.vapid().publicKey };
  }

  /** `{ endpoint, keys: { p256dh, auth } }`, saved or updated by endpoint. */
  @Post('subscriptions')
  @HttpCode(HttpStatus.CREATED)
  async subscribe(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<void> {
    this.vapid();
    const { endpoint, keys } = parseOrBadRequest(
      subscribeBodySchema,
      body ?? {},
      'body',
    );
    await this.subscriptions.save(user.id, {
      endpoint,
      keys,
      ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}),
    });
  }

  /** `{ endpoint }`: 204 also when it was not saved. */
  @Delete('subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ): Promise<void> {
    this.vapid();
    const { endpoint } = parseOrBadRequest(
      unsubscribeBodySchema,
      body ?? {},
      'body',
    );
    await this.subscriptions.remove(user.id, endpoint);
  }

  private vapid() {
    const vapid = vapidDetails(this.config);
    if (!vapid) {
      throw new NotFoundException('Push notifications are not configured');
    }
    return vapid;
  }
}
