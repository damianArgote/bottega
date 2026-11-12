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
  createAccountSchema,
  PaymentAccountsService,
  updateAccountSchema,
} from './payment-accounts.service.js';

const idSchema = z.uuid();

/**
 * A business's payment accounts (prompt 07c) through the admin API key. The
 * same routes exist under /staff for the team.
 */
@Controller('admin/businesses/:businessId/payment-accounts')
@UseGuards(AdminApiKeyGuard)
export class AdminPaymentAccountsController {
  constructor(private readonly accounts: PaymentAccountsService) {}

  @Get()
  list(@Param('businessId') businessId: string) {
    return this.accounts.list(business(businessId));
  }

  /**
   * Body `{ provider: 'mercadopago', label, accessToken, webhookSecret }` or
   * `{ provider: 'transfer', label, alias, holder }`, plus `isDefault?` and
   * `active?`.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Param('businessId') businessId: string, @Body() body: unknown) {
    return this.accounts.create(
      business(businessId),
      parseOrBadRequest(createAccountSchema, body ?? {}, 'body'),
    );
  }

  @Patch(':accountId')
  update(
    @Param('businessId') businessId: string,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    return this.accounts.update(
      business(businessId),
      id(accountId),
      parseOrBadRequest(updateAccountSchema, body ?? {}, 'body'),
    );
  }

  @Delete(':accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('businessId') businessId: string,
    @Param('accountId') accountId: string,
  ) {
    await this.accounts.delete(business(businessId), id(accountId));
  }
}

/**
 * The same routes for the BotSuite46 team (`STAFF`) from the inbox. Every
 * change is logged with who did it (ids only).
 */
@Controller('staff/businesses/:businessId/payment-accounts')
@UseGuards(SessionGuard, StaffGuard)
export class StaffPaymentAccountsController {
  private readonly logger = new Logger(StaffPaymentAccountsController.name);

  constructor(private readonly accounts: PaymentAccountsService) {}

  @Get()
  list(@Param('businessId') businessId: string) {
    return this.accounts.list(business(businessId));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const created = await this.accounts.create(
      business(businessId),
      parseOrBadRequest(createAccountSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'created payment account', created.id);
    return created;
  }

  @Patch(':accountId')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    const updated = await this.accounts.update(
      business(businessId),
      id(accountId),
      parseOrBadRequest(updateAccountSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'updated payment account', updated.id);
    return updated;
  }

  @Delete(':accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('accountId') accountId: string,
  ) {
    const target = id(accountId);
    await this.accounts.delete(business(businessId), target);
    this.audit(user, 'deleted payment account', target);
  }

  private audit(user: SessionUser, action: string, targetId: string): void {
    this.logger.log(`Staff user ${user.id} ${action} ${targetId}`);
  }
}

function business(value: string): string {
  return parseOrBadRequest(businessIdSchema, value, 'businessId');
}

function id(value: string): string {
  return parseOrBadRequest(idSchema, value, 'accountId');
}
