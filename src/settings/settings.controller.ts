import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
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
import { UsersService } from '../auth/users.service.js';
import { AgentPreviewService } from '../bot/agent-preview.service.js';

/** Previews per business per hour (each one is a real model call). */
export const PREVIEW_RATE_LIMITER = Symbol('PREVIEW_RATE_LIMITER');

const versionSchema = z.coerce.number().int().positive().max(2_147_483_647);
const role = z.enum(['OWNER', 'AGENT']);
const addUserBodySchema = z
  .object({
    email: z.string().trim().pipe(z.email()),
    name: z.string().trim().min(1).max(100),
    role,
  })
  .strict();
const updateUserBodySchema = z
  .object({ role: role.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => b.role !== undefined || b.active !== undefined, {
    message: 'send role, active or both',
  });

/**
 * The backoffice: the business's agent and people, for its OWNERs only. Every route
 * lives under /inbox/businesses/:businessId/settings.
 */
@Controller('inbox/businesses/:businessId/settings')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class SettingsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly preview: AgentPreviewService,
    @Inject(PREVIEW_RATE_LIMITER) private readonly previews: LoginRateLimiter,
    private readonly users: UsersService,
  ) {}

  @Get('agent')
  agent(@CurrentBusiness() access: BusinessAccess) {
    return this.agents.getSettings(access.businessId);
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

  @Get('users')
  async listUsers(@CurrentBusiness() access: BusinessAccess) {
    return { users: await this.users.listMembers(access.businessId) };
  }

  /**
   * `{ email, name, role }`. A new user gets a temporary password, shown
   * only in this response (`temporaryPassword`, null for an existing user).
   */
  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  addUser(@CurrentBusiness() access: BusinessAccess, @Body() body: unknown) {
    return this.users.addMember(
      access.businessId,
      parseOrBadRequest(addUserBodySchema, body ?? {}, 'body'),
    );
  }

  /** `{ role?, active? }` in this business; 409 `LAST_OWNER`. */
  @Patch('users/:userId')
  updateUser(
    @CurrentBusiness() access: BusinessAccess,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.users.updateMember(access.businessId, {
      userId: parseOrBadRequest(z.uuid(), userId, 'userId'),
      ...parseOrBadRequest(updateUserBodySchema, body ?? {}, 'body'),
    });
  }
}
