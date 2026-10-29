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
  sheetBodySchema,
  itemsQuerySchema,
  parseImportRequest,
} from '../catalog/catalog.schemas.js';
import { CatalogSheetService } from '../catalog/catalog-sheet.service.js';
import { CatalogSyncScheduler } from '../catalog/catalog-sync.scheduler.js';
import { CatalogService } from '../catalog/catalog.service.js';

/**
 * The business's catalog (backoffice), for its OWNERs only: the same
 * imports and item writes as the admin API. The item cap is not here.
 */
@Controller('inbox/businesses/:businessId/settings/catalog')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly sheets: CatalogSheetService,
    private readonly scheduler: CatalogSyncScheduler,
  ) {}

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

  /** The Google Sheet published as CSV and its last sync. */
  @Get('sheet')
  sheet(@CurrentBusiness() access: BusinessAccess) {
    return this.sheets.get(access.businessId);
  }

  /** `{ url }` (null removes it); the first sync runs right away. */
  @Put('sheet')
  async putSheet(
    @CurrentBusiness() access: BusinessAccess,
    @Body() body: unknown,
  ) {
    const view = await this.sheets.set(
      access.businessId,
      parseOrBadRequest(sheetBodySchema, body ?? {}, 'body').url,
    );
    this.scheduler.schedule();
    return view;
  }

  /** "Sincronizar ahora". */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sheets.sync(access.businessId, user.id);
  }
}
