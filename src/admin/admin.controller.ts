import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { agentProfileSchema } from '../agents/agent-profile.schema.js';
import { AgentsService } from '../agents/agents.service.js';
import { UsersService } from '../auth/users.service.js';
import { AgentPreviewService } from '../bot/agent-preview.service.js';
import { AdminApiKeyGuard } from './admin-api-key.guard.js';
import {
  addUserBodySchema,
  agentPreviewBodySchema,
  businessIdSchema,
  conversationIdSchema,
  createBusinessBodySchema,
  createLineBodySchema,
  conversationQuerySchema,
  handoffsQuerySchema,
  humanReplyBodySchema,
  idempotencyKeySchema,
  leadsQuerySchema,
  messagesQuerySchema,
  parseOrBadRequest,
  resumeBodySchema,
  waIdSchema,
} from './admin.schemas.js';
import { AdminService, type HumanReplyResult } from './admin.service.js';
import { BusinessesService } from './businesses.service.js';

/** HTTP status per human reply outcome, so `curl -f` fails on a rejection. */
const REPLY_STATUS: Record<HumanReplyResult['outcome'], number> = {
  sent: HttpStatus.OK,
  replayed: HttpStatus.OK,
  uncertain: HttpStatus.ACCEPTED,
  rejected: HttpStatus.BAD_GATEWAY,
};

/** Team operations. Every route requires the admin API key. */
@Controller('admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly businesses: BusinessesService,
    private readonly agents: AgentsService,
    private readonly preview: AgentPreviewService,
    private readonly users: UsersService,
  ) {}

  /** Adds an operator to the business (creates the user if new). */
  @Post('businesses/:id/users')
  @HttpCode(HttpStatus.CREATED)
  addUser(@Param('id') id: string, @Body() body: unknown) {
    return this.users.addToBusiness(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(addUserBodySchema, body ?? {}, 'body'),
    );
  }

  @Get('businesses/:id/agent')
  agent(@Param('id') id: string) {
    return this.agents.get(parseOrBadRequest(businessIdSchema, id, 'id'));
  }

  /** Replaces the whole profile; every put raises its version. */
  @Put('businesses/:id/agent')
  putAgent(@Param('id') id: string, @Body() body: unknown) {
    return this.agents.put(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(agentProfileSchema, body ?? {}, 'body'),
    );
  }

  /** One turn against the real model; sends and stores nothing. */
  @Post('businesses/:id/agent/preview')
  @HttpCode(HttpStatus.OK)
  previewAgent(@Param('id') id: string, @Body() body: unknown) {
    const { messages } = parseOrBadRequest(
      agentPreviewBodySchema,
      body ?? {},
      'body',
    );
    return this.preview.run(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      messages,
    );
  }

  @Post('businesses')
  @HttpCode(HttpStatus.CREATED)
  createBusiness(@Body() body: unknown) {
    return this.businesses.createBusiness(
      parseOrBadRequest(createBusinessBodySchema, body ?? {}, 'body'),
    );
  }

  /** Returns the webhook URL and verify token to paste in the Meta app. */
  @Post('businesses/:id/lines')
  @HttpCode(HttpStatus.CREATED)
  createLine(@Param('id') id: string, @Body() body: unknown) {
    return this.businesses.createLine(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(createLineBodySchema, body ?? {}, 'body'),
    );
  }

  @Get('leads')
  leads(@Query() query: unknown) {
    return this.admin.listLeads(
      parseOrBadRequest(leadsQuerySchema, query, 'query'),
    );
  }

  @Get('handoffs')
  handoffs(@Query() query: unknown) {
    return this.admin.listHandoffs(
      parseOrBadRequest(handoffsQuerySchema, query, 'query'),
    );
  }

  @Get('messages')
  messages(@Query() query: unknown) {
    return this.admin.listAttentionMessages(
      parseOrBadRequest(messagesQuerySchema, query, 'query'),
    );
  }

  @Get('conversations/by-wa/:waId')
  conversationByWaId(@Param('waId') waId: string, @Query() query: unknown) {
    const { limit } = parseOrBadRequest(
      conversationQuerySchema,
      query,
      'query',
    );
    return this.admin.getConversationByWaId(
      parseOrBadRequest(waIdSchema, waId, 'waId'),
      limit,
    );
  }

  @Get('conversations/:id')
  conversation(@Param('id') id: string, @Query() query: unknown) {
    const { limit } = parseOrBadRequest(
      conversationQuerySchema,
      query,
      'query',
    );
    return this.admin.getConversation(this.id(id), limit);
  }

  @Post('conversations/:id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@Param('id') id: string) {
    return this.admin.pause(this.id(id));
  }

  @Post('conversations/:id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@Param('id') id: string, @Body() body: unknown) {
    const { resolveHandoffs } = parseOrBadRequest(
      resumeBodySchema,
      body ?? {},
      'body',
    );
    return this.admin.resume(this.id(id), resolveHandoffs);
  }

  @Post('conversations/:id/messages')
  async reply(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HumanReplyResult> {
    const conversationId = this.id(id);
    const { text } = parseOrBadRequest(humanReplyBodySchema, body, 'body');
    const key = parseOrBadRequest(
      idempotencyKeySchema,
      idempotencyKey,
      'Idempotency-Key',
    );
    const result = await this.admin.sendHumanReply(conversationId, text, key);
    res.status(REPLY_STATUS[result.outcome]);
    return result;
  }

  private id(value: string): string {
    return parseOrBadRequest(conversationIdSchema, value, 'id');
  }
}
