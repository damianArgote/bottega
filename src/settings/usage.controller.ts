import { Controller, Get, UseGuards } from '@nestjs/common';
import { AiLimitsService } from '../ai/ai-limits.service.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { SessionGuard } from '../auth/session.guard.js';

/**
 * The business's AI usage of the month, for any of its people. Read only:
 * the caps change only through the admin API.
 */
@Controller('inbox/businesses/:businessId/settings/usage')
@UseGuards(SessionGuard, BusinessAccessGuard)
export class UsageController {
  constructor(private readonly aiLimits: AiLimitsService) {}

  @Get()
  usage(@CurrentBusiness() access: BusinessAccess) {
    return this.aiLimits.usage(access.businessId);
  }
}
