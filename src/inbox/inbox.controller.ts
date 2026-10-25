import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
import { InboxQueriesService } from './inbox-queries.service.js';
import { InboxService } from './inbox.service.js';

const conversationIdSchema = z.uuid();
const takeBodySchema = z.object({ force: z.boolean().default(false) }).strict();
const listQuerySchema = z
  .object({
    view: z.enum(['mine', 'unassigned', 'pending', 'resolved']),
    lineId: z.uuid().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();
const changesQuerySchema = z
  .object({ cursor: z.string().min(1).max(500).optional() })
  .strict();
const messagesQuerySchema = z
  .object({
    before: z.string().optional(),
    after: z.string().optional(),
  })
  .strict();

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
    private readonly queries: InboxQueriesService,
  ) {}

  /** `?view=mine|unassigned|pending|resolved&lineId=&q=&cursor=`, 30 a page. */
  @Get('conversations')
  conversations(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Query() query: unknown,
  ) {
    return this.queries.list(
      access,
      user,
      parseOrBadRequest(listQuerySchema, query, 'query'),
    );
  }

  /** Conversations changed since `?cursor=` (polling); see InboxQueriesService.changes. */
  @Get('changes')
  changes(@CurrentBusiness() access: BusinessAccess, @Query() query: unknown) {
    const { cursor } = parseOrBadRequest(changesQuerySchema, query, 'query');
    return this.queries.changes(access, cursor);
  }

  /** `?before=<seq>` older, `?after=<seq>` newer, 50 a page. */
  @Get('conversations/:conversationId/messages')
  messages(
    @CurrentBusiness() access: BusinessAccess,
    @Param('conversationId') id: string,
    @Query() query: unknown,
  ) {
    return this.queries.messages(
      access,
      this.id(id),
      parseOrBadRequest(messagesQuerySchema, query, 'query'),
    );
  }

  @Get('lines')
  lines(@CurrentBusiness() access: BusinessAccess) {
    return this.queries.lines(access);
  }

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
