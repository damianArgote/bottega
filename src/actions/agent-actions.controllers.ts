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
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { RoleGuard } from '../auth/role.guard.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import {
  AgentActionsService,
  createActionSchema,
  testActionSchema,
  updateActionSchema,
} from './agent-actions.service.js';

const idSchema = z.uuid();

/**
 * A business's actions (prompt 07b) through the admin API key. The same
 * routes exist under /staff for the team.
 */
@Controller('admin/businesses/:businessId/actions')
@UseGuards(AdminApiKeyGuard)
export class AdminActionsController {
  constructor(private readonly actions: AgentActionsService) {}

  @Get()
  list(@Param('businessId') businessId: string) {
    return this.actions.list(business(businessId));
  }

  /**
   * Body `{ name, description, parameters?, url, kind, timeoutMs?, active? }`;
   * the answer has the signing `secret`, only this once.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Param('businessId') businessId: string, @Body() body: unknown) {
    return this.actions.create(
      business(businessId),
      parseOrBadRequest(createActionSchema, body ?? {}, 'body'),
    );
  }

  @Patch(':actionId')
  update(
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    return this.actions.update(
      business(businessId),
      id(actionId),
      parseOrBadRequest(updateActionSchema, body ?? {}, 'body'),
    );
  }

  @Post(':actionId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  rotateSecret(
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
  ) {
    return this.actions.rotateSecret(business(businessId), id(actionId));
  }

  /** Body `{ arguments }`: calls it once and shows the answer. */
  @Post(':actionId/test')
  @HttpCode(HttpStatus.OK)
  test(
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    return this.actions.test(
      business(businessId),
      id(actionId),
      parseOrBadRequest(testActionSchema, body ?? {}, 'body'),
    );
  }

  @Delete(':actionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
  ) {
    await this.actions.delete(business(businessId), id(actionId));
  }
}

/**
 * The same routes for the BotSuite46 team (`STAFF`) from the inbox. Every
 * change is logged with who did it (ids only).
 */
@Controller('staff/businesses/:businessId/actions')
@UseGuards(SessionGuard, StaffGuard)
export class StaffActionsController {
  private readonly logger = new Logger(StaffActionsController.name);

  constructor(private readonly actions: AgentActionsService) {}

  @Get()
  list(@Param('businessId') businessId: string) {
    return this.actions.list(business(businessId));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const created = await this.actions.create(
      business(businessId),
      parseOrBadRequest(createActionSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'created action', created.id);
    return created;
  }

  @Patch(':actionId')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    const updated = await this.actions.update(
      business(businessId),
      id(actionId),
      parseOrBadRequest(updateActionSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'updated action', updated.id);
    return updated;
  }

  @Post(':actionId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  async rotateSecret(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
  ) {
    const rotated = await this.actions.rotateSecret(
      business(businessId),
      id(actionId),
    );
    this.audit(user, 'rotated action secret', rotated.id);
    return rotated;
  }

  @Post(':actionId/test')
  @HttpCode(HttpStatus.OK)
  async test(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    const target = id(actionId);
    const result = await this.actions.test(
      business(businessId),
      target,
      parseOrBadRequest(testActionSchema, body ?? {}, 'body'),
    );
    this.audit(user, 'tested action', target);
    return result;
  }

  @Delete(':actionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
  ) {
    const target = id(actionId);
    await this.actions.delete(business(businessId), target);
    this.audit(user, 'deleted action', target);
  }

  private audit(user: SessionUser, action: string, targetId: string): void {
    this.logger.log(`Staff user ${user.id} ${action} ${targetId}`);
  }
}

/**
 * The business's actions in the backoffice, for its OWNERs: read only in
 * this part (the team creates and edits them).
 */
@Controller('inbox/businesses/:businessId/settings/actions')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class OwnerActionsController {
  constructor(private readonly actions: AgentActionsService) {}

  @Get()
  list(@Param('businessId') businessId: string) {
    return this.actions.list(business(businessId));
  }
}

function business(value: string): string {
  return parseOrBadRequest(businessIdSchema, value, 'businessId');
}

function id(value: string): string {
  return parseOrBadRequest(idSchema, value, 'actionId');
}
