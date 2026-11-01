import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminApiKeyGuard } from '../admin/admin-api-key.guard.js';
import { businessIdSchema, parseOrBadRequest } from '../admin/admin.schemas.js';
import type { SessionUser } from '../auth/auth.service.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import {
  createKeySchema,
  createSubscriptionSchema,
  IntegrationsService,
  updateSubscriptionSchema,
} from './integrations.service.js';

const idSchema = z.uuid();

/**
 * Webhook subscriptions and integration keys of a business, through the
 * admin API key. The same routes exist under /staff for the team.
 */
@Controller('admin/businesses/:businessId')
@UseGuards(AdminApiKeyGuard)
export class AdminIntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('webhooks')
  listSubscriptions(@Param('businessId') businessId: string) {
    return this.integrations.listSubscriptions(business(businessId));
  }

  /** Body `{ url, events }`; the answer has the signing `secret`, only this once. */
  @Post('webhooks')
  @HttpCode(HttpStatus.CREATED)
  createSubscription(
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    return this.integrations.createSubscription(
      business(businessId),
      parseOrBadRequest(createSubscriptionSchema, body ?? {}, 'body'),
    );
  }

  /** Body `{ url?, events?, active? }`. */
  @Patch('webhooks/:subscriptionId')
  updateSubscription(
    @Param('businessId') businessId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: unknown,
  ) {
    return this.integrations.updateSubscription(
      business(businessId),
      id(subscriptionId, 'subscriptionId'),
      parseOrBadRequest(updateSubscriptionSchema, body ?? {}, 'body'),
    );
  }

  /** A new signing secret, shown only this once. */
  @Post('webhooks/:subscriptionId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  rotateSecret(
    @Param('businessId') businessId: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    return this.integrations.rotateSecret(
      business(businessId),
      id(subscriptionId, 'subscriptionId'),
    );
  }

  @Delete('webhooks/:subscriptionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSubscription(
    @Param('businessId') businessId: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    await this.integrations.deleteSubscription(
      business(businessId),
      id(subscriptionId, 'subscriptionId'),
    );
  }

  @Get('integration-keys')
  listKeys(@Param('businessId') businessId: string) {
    return this.integrations.listKeys(business(businessId));
  }

  /** Body `{ name }`; the answer has the `key`, only this once. */
  @Post('integration-keys')
  @HttpCode(HttpStatus.CREATED)
  createKey(@Param('businessId') businessId: string, @Body() body: unknown) {
    return this.integrations.createKey(
      business(businessId),
      parseOrBadRequest(createKeySchema, body ?? {}, 'body'),
    );
  }

  @Delete('integration-keys/:keyId')
  revokeKey(
    @Param('businessId') businessId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.integrations.revokeKey(
      business(businessId),
      id(keyId, 'keyId'),
    );
  }
}

/**
 * The same routes for the BotSuite46 team (`STAFF`) from the inbox. Every
 * change is logged with who did it (ids only).
 */
@Controller('staff/businesses/:businessId')
@UseGuards(SessionGuard, StaffGuard)
export class StaffIntegrationsController {
  private readonly logger = new Logger(StaffIntegrationsController.name);

  constructor(private readonly integrations: IntegrationsService) {}

  @Get('webhooks')
  listSubscriptions(@Param('businessId') businessId: string) {
    return this.integrations.listSubscriptions(business(businessId));
  }

  @Post('webhooks')
  @HttpCode(HttpStatus.CREATED)
  async createSubscription(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const created = await this.integrations.createSubscription(
      business(businessId),
      parseOrBadRequest(createSubscriptionSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'created webhook subscription', created.id);
    return created;
  }

  @Patch('webhooks/:subscriptionId')
  async updateSubscription(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: unknown,
  ) {
    const updated = await this.integrations.updateSubscription(
      business(businessId),
      id(subscriptionId, 'subscriptionId'),
      parseOrBadRequest(updateSubscriptionSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'updated webhook subscription', updated.id);
    return updated;
  }

  @Post('webhooks/:subscriptionId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  async rotateSecret(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    const rotated = await this.integrations.rotateSecret(
      business(businessId),
      id(subscriptionId, 'subscriptionId'),
    );
    this.audit(user, 'rotated webhook secret', rotated.id);
    return rotated;
  }

  @Delete('webhooks/:subscriptionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSubscription(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    const target = id(subscriptionId, 'subscriptionId');
    await this.integrations.deleteSubscription(business(businessId), target);
    this.audit(user, 'deleted webhook subscription', target);
  }

  @Get('integration-keys')
  listKeys(@Param('businessId') businessId: string) {
    return this.integrations.listKeys(business(businessId));
  }

  @Post('integration-keys')
  @HttpCode(HttpStatus.CREATED)
  async createKey(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const created = await this.integrations.createKey(
      business(businessId),
      parseOrBadRequest(createKeySchema, body ?? {}, 'body'),
    );
    this.audit(user, 'created integration key', created.id);
    return created;
  }

  @Delete('integration-keys/:keyId')
  async revokeKey(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('keyId') keyId: string,
  ) {
    const revoked = await this.integrations.revokeKey(
      business(businessId),
      id(keyId, 'keyId'),
    );
    this.audit(user, 'revoked integration key', revoked.id);
    return revoked;
  }

  private audit(user: SessionUser, action: string, targetId: string): void {
    this.logger.log(`Staff user ${user.id} ${action} ${targetId}`);
  }
}

function business(value: string): string {
  return parseOrBadRequest(businessIdSchema, value, 'businessId');
}

function id(value: string, name: string): string {
  return parseOrBadRequest(idSchema, value, name);
}
