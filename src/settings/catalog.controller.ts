import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import type { SessionUser } from '../auth/auth.service.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { RoleGuard } from '../auth/role.guard.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import {
  externalIdSchema,
  importIdSchema,
  itemBodySchema,
  mappingBodySchema,
  itemsQuerySchema,
  parseImportRequest,
} from '../catalog/catalog.schemas.js';
import { CatalogService } from '../catalog/catalog.service.js';

/**
 * The business's catalog (backoffice), for its OWNERs only: the same
 * imports and item writes as the admin API. The item cap is not here.
 */
@Controller('inbox/businesses/:businessId/settings/catalog')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Post('imports')
  @HttpCode(HttpStatus.CREATED)
  createImport(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
    @Query('mapping') mapping: unknown,
  ) {
    return this.catalog.preview(
      access.businessId,
      parseImportRequest(contentType, body, mapping),
      user.id,
    );
  }

  @Get('imports/:importId')
  getImport(
    @CurrentBusiness() access: BusinessAccess,
    @Param('importId') importId: string,
  ) {
    return this.catalog.getImport(
      access.businessId,
      parseOrBadRequest(importIdSchema, importId, 'importId'),
    );
  }

  /** Confirms or corrects the column mapping of a preview. */
  @Put('imports/:importId/mapping')
  confirmMapping(
    @CurrentBusiness() access: BusinessAccess,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.confirmMapping(
      access.businessId,
      parseOrBadRequest(importIdSchema, importId, 'importId'),
      parseOrBadRequest(mappingBodySchema, body ?? {}, 'body').mapping,
    );
  }

  @Post('imports/:importId/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('importId') importId: string,
  ) {
    return this.catalog.apply(
      access.businessId,
      parseOrBadRequest(importIdSchema, importId, 'importId'),
      user.id,
    );
  }

  @Post('imports/:importId/discard')
  @HttpCode(HttpStatus.OK)
  discard(
    @CurrentBusiness() access: BusinessAccess,
    @Param('importId') importId: string,
  ) {
    return this.catalog.discard(
      access.businessId,
      parseOrBadRequest(importIdSchema, importId, 'importId'),
    );
  }

  @Get('items')
  items(@CurrentBusiness() access: BusinessAccess, @Query() query: unknown) {
    return this.catalog.listItems(
      access.businessId,
      parseOrBadRequest(itemsQuerySchema, query, 'query'),
    );
  }

  @Put('items/:externalId')
  putItem(
    @CurrentBusiness() access: BusinessAccess,
    @Param('externalId') externalId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.putItem(
      access.businessId,
      parseOrBadRequest(externalIdSchema, externalId, 'externalId'),
      parseOrBadRequest(itemBodySchema, body ?? {}, 'body'),
    );
  }

  /** Marks the item unavailable ("agotado"). */
  @Delete('items/:externalId')
  removeItem(
    @CurrentBusiness() access: BusinessAccess,
    @Param('externalId') externalId: string,
  ) {
    return this.catalog.removeItem(
      access.businessId,
      parseOrBadRequest(externalIdSchema, externalId, 'externalId'),
    );
  }
}
