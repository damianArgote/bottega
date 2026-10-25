import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import type { SessionUser } from '../auth/auth.service.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { ConversationActionsService } from './conversation-actions.service.js';
import { InboxService } from './inbox.service.js';

const conversationIdSchema = z.uuid();
const takeBodySchema = z.object({ force: z.boolean().default(false) }).strict();

/**
 * The inbox API, for the people of each business. Every route lives under
 * /inbox/businesses/:businessId and requires a session and a membership in
 * that business.
 */
@Controller('inbox/businesses/:businessId')
@UseGuards(SessionGuard, BusinessAccessGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly actions: ConversationActionsService,
  ) {}

  /** The business and the user's role in it. */
  @Get()
  business(@CurrentBusiness() access: BusinessAccess) {
    return this.inbox.business(access);
  }

  /** Body `{ force?: boolean }`; force takes it from someone else (OWNER). */
  @Post('conversations/:conversationId/take')
  @HttpCode(HttpStatus.OK)
  take(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    const { force } = parseOrBadRequest(takeBodySchema, body ?? {}, 'body');
    return this.actions.take(access, user, this.id(id), { force });
  }

  @Post('conversations/:conversationId/release')
  @HttpCode(HttpStatus.OK)
  release(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('conversationId') id: string,
  ) {
    return this.actions.release(access, user, this.id(id));
  }

  /** "Devolver al bot". */
  @Post('conversations/:conversationId/handback')
  @HttpCode(HttpStatus.OK)
  handBack(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('conversationId') id: string,
  ) {
    return this.actions.handBack(access, user, this.id(id));
  }

  @Post('conversations/:conversationId/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('conversationId') id: string,
  ) {
    return this.actions.resolve(access, user, this.id(id));
  }

  private id(value: string): string {
    return parseOrBadRequest(conversationIdSchema, value, 'conversationId');
  }
}
