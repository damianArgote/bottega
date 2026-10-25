import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  agentPreviewBodySchema,
  parseOrBadRequest,
} from '../admin/admin.schemas.js';
import { agentSettingsSchema } from '../agents/agent-profile.schema.js';
import { AgentsService } from '../agents/agents.service.js';
import type { SessionUser } from '../auth/auth.service.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import type { LoginRateLimiter } from '../auth/login-rate-limiter.js';
import { RoleGuard } from '../auth/role.guard.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { AgentPreviewService } from '../bot/agent-preview.service.js';

/** Previews per business per hour (each one is a real model call). */
export const PREVIEW_RATE_LIMITER = Symbol('PREVIEW_RATE_LIMITER');

const versionSchema = z.coerce.number().int().positive().max(2_147_483_647);

/**
 * The backoffice: the business's settings, for its OWNERs only. Every route
 * lives under /inbox/businesses/:businessId/settings.
 */
@Controller('inbox/businesses/:businessId/settings')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class SettingsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly preview: AgentPreviewService,
    @Inject(PREVIEW_RATE_LIMITER) private readonly previews: LoginRateLimiter,
  ) {}

  @Get('agent')
  agent(@CurrentBusiness() access: BusinessAccess) {
    return this.agents.get(access.businessId);
  }

  /** The 02b profile without `model` and `demoEnabled` (admin API only). */
  @Put('agent')
  putAgent(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    return this.agents.putSettings(
      access.businessId,
      parseOrBadRequest(agentSettingsSchema, body ?? {}, 'body'),
      user.id,
    );
  }

  @Get('agent/versions')
  async versions(@CurrentBusiness() access: BusinessAccess) {
    return { versions: await this.agents.versions(access.businessId) };
  }

  /** Saves that version again as a new one. */
  @Post('agent/versions/:version/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('version') version: string,
  ) {
    return this.agents.restore(
      access.businessId,
      parseOrBadRequest(versionSchema, version, 'version'),
      user.id,
    );
  }

  /** One turn against the real model; sends and stores nothing. */
  @Post('agent/preview')
  @HttpCode(HttpStatus.OK)
  previewAgent(
    @CurrentBusiness() access: BusinessAccess,
    @Body() body: unknown,
  ) {
    const { messages } = parseOrBadRequest(
      agentPreviewBodySchema,
      body ?? {},
      'body',
    );
    if (!this.previews.attempt([`business:${access.businessId}`])) {
      throw new HttpException(
        'Too many previews for this business, try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.preview.run(access.businessId, messages);
  }
}
