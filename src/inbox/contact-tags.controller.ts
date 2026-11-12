import { Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import type { SessionUser } from '../auth/auth.service.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import {
  contactIdSchema,
  contactTagsBodySchema,
} from '../contacts/contact-tags.js';
import { ContactTagsService } from '../contacts/contact-tags.service.js';

/** A contact's tags, for any person of the business (OWNER and AGENT). */
@Controller('inbox/businesses/:businessId/contacts/:contactId/tags')
@UseGuards(SessionGuard, BusinessAccessGuard)
export class ContactTagsInboxController {
  constructor(private readonly tags: ContactTagsService) {}

  /** Body `{ tagIds }`: every tag the contact keeps. */
  @Put()
  replace(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
  ) {
    const { tagIds } = parseOrBadRequest(
      contactTagsBodySchema,
      body ?? {},
      'body',
    );
    return this.tags.setForContact(
      access.businessId,
      parseOrBadRequest(contactIdSchema, contactId, 'contactId'),
      tagIds,
      user,
    );
  }
}
