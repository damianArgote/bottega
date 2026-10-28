import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  lineCredentialsBodySchema,
  lineIdSchema,
  parseOrBadRequest,
} from '../admin/admin.schemas.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { RoleGuard } from '../auth/role.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { LineOnboardingService } from '../onboarding/line-onboarding.service.js';

/**
 * The business's WhatsApp connection, for its OWNERs: what is missing to
 * finish onboarding, and the Meta credentials when the business sets up its
 * own app (no access for the team). Never returns secrets.
 */
@Controller('inbox/businesses/:businessId/settings/whatsapp')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class WhatsAppSettingsController {
  constructor(private readonly onboarding: LineOnboardingService) {}

  /** The connection state of each line of the business, drafts included. */
  @Get()
  status(@CurrentBusiness() access: BusinessAccess) {
    return this.onboarding.businessStatus(access.businessId);
  }

  /** Same checks as the admin route; a line of another business is 404. */
  @Put('lines/:lineId/credentials')
  setCredentials(
    @CurrentBusiness() access: BusinessAccess,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    return this.onboarding.setCredentials(
      parseOrBadRequest(lineIdSchema, lineId, 'lineId'),
      parseOrBadRequest(lineCredentialsBodySchema, body ?? {}, 'body'),
      access.businessId,
    );
  }
}
