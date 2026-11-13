import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { RoleGuard } from '../auth/role.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  contactTagChangesSchema,
  contactTagIdSchema,
  newContactTagSchema,
} from '../contacts/contact-tags.js';
import { ContactTagsService } from '../contacts/contact-tags.service.js';

/**
 * The business's contact tags (backoffice), for its OWNERs only: list,
 * create, edit and delete them (409 TAG_IN_USE while a catalog uses one).
 */
@Controller('inbox/businesses/:businessId/settings/contact-tags')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class ContactTagsController {
  constructor(private readonly tags: ContactTagsService) {}

  @Get()
  list(@CurrentBusiness() access: BusinessAccess) {
    return this.tags.list(access.businessId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentBusiness() access: BusinessAccess, @Body() body: unknown) {
    return this.tags.create(
      access.businessId,
      parseOrBadRequest(newContactTagSchema, body ?? {}, 'body'),
    );
  }

  @Patch(':tagId')
  update(
    @CurrentBusiness() access: BusinessAccess,
    @Param('tagId') tagId: string,
    @Body() body: unknown,
  ) {
    return this.tags.update(
      access.businessId,
      parseOrBadRequest(contactTagIdSchema, tagId, 'tagId'),
      parseOrBadRequest(contactTagChangesSchema, body ?? {}, 'body'),
    );
  }

  @Delete(':tagId')
  remove(
    @CurrentBusiness() access: BusinessAccess,
    @Param('tagId') tagId: string,
  ) {
    return this.tags.remove(
      access.businessId,
      parseOrBadRequest(contactTagIdSchema, tagId, 'tagId'),
    );
  }
}
