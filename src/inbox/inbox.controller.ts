import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { InboxService } from './inbox.service.js';

/**
 * The inbox API, for the people of each business. Every route lives under
 * /inbox/businesses/:businessId and requires a session and a membership in
 * that business. Prompt 04 adds conversations and messages.
 */
@Controller('inbox/businesses/:businessId')
@UseGuards(SessionGuard, BusinessAccessGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** The business and the user's role in it. */
  @Get()
  business(@CurrentBusiness() access: BusinessAccess) {
    return this.inbox.business(access);
  }
}
