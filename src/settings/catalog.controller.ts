import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  catalogChangesSchema,
  catalogIdSchema,
  externalIdSchema,
  importIdSchema,
  itemBodySchema,
  itemsQuerySchema,
  mappingBodySchema,
  newCatalogSchema,
  parseImportRequest,
  sheetBodySchema,
} from '../catalog/catalog.schemas.js';
import { CatalogSheetService } from '../catalog/catalog-sheet.service.js';
import { CatalogSyncScheduler } from '../catalog/catalog-sync.scheduler.js';
import { CatalogService } from '../catalog/catalog.service.js';
import {
  type CatalogRef,
  CatalogsService,
} from '../catalog/catalogs.service.js';

/**
 * The business's catalogs (backoffice), for its OWNERs only: list, create,
 * rename, reorder and delete them.
 */
@Controller('inbox/businesses/:businessId/settings/catalogs')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class CatalogsController {
  constructor(private readonly catalogs: CatalogsService) {}

  @Get()
  list(@CurrentBusiness() access: BusinessAccess) {
    return this.catalogs.list(access.businessId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentBusiness() access: BusinessAccess, @Body() body: unknown) {
    return this.catalogs.create(
      access.businessId,
      parseOrBadRequest(newCatalogSchema, body ?? {}, 'body').name,
    );
  }

  @Patch(':catalogId')
  async update(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string,
    @Body() body: unknown,
  ) {
    return this.catalogs.update(
      await this.catalogs.resolve(
        access.businessId,
        parseOrBadRequest(catalogIdSchema, catalogId, 'catalogId'),
      ),
      parseOrBadRequest(catalogChangesSchema, body ?? {}, 'body'),
    );
  }

  /** Deletes the catalog and its items (409 LAST_CATALOG for the only one). */
  @Delete(':catalogId')
  async remove(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string,
  ) {
    return this.catalogs.remove(
      await this.catalogs.resolve(
        access.businessId,
        parseOrBadRequest(catalogIdSchema, catalogId, 'catalogId'),
      ),
    );
  }
}

/**
 * One catalog of the business (backoffice), for its OWNERs only: the same
 * imports and item writes as the admin API. The item cap is not here.
 * `.../catalog/...` (without a catalog: the routes before several catalogs
 * existed) acts on the business's first catalog.
 */
@Controller([
  'inbox/businesses/:businessId/settings/catalog',
  'inbox/businesses/:businessId/settings/catalogs/:catalogId',
])
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly catalogs: CatalogsService,
    private readonly sheets: CatalogSheetService,
    private readonly scheduler: CatalogSyncScheduler,
  ) {}

  @Post('imports')
  @HttpCode(HttpStatus.CREATED)
  async createImport(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @CurrentUser() user: SessionUser,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
    @Query('mapping') mapping: unknown,
  ) {
    const source = parseImportRequest(contentType, body, mapping);
    return this.catalog.preview(
      await this.ref(access, catalogId),
      source,
      user.id,
    );
  }

  @Get('imports/:importId')
  async getImport(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
  ) {
    const id = parseOrBadRequest(importIdSchema, importId, 'importId');
    return this.catalog.getImport(await this.ref(access, catalogId), id);
  }

  /** Confirms or corrects the column mapping of a preview. */
  @Put('imports/:importId/mapping')
  async confirmMapping(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ) {
    const id = parseOrBadRequest(importIdSchema, importId, 'importId');
    const { mapping } = parseOrBadRequest(
      mappingBodySchema,
      body ?? {},
      'body',
    );
    return this.catalog.confirmMapping(
      await this.ref(access, catalogId),
      id,
      mapping,
    );
  }

  @Post('imports/:importId/apply')
  @HttpCode(HttpStatus.OK)
  async apply(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @CurrentUser() user: SessionUser,
    @Param('importId') importId: string,
  ) {
    const id = parseOrBadRequest(importIdSchema, importId, 'importId');
    return this.catalog.apply(await this.ref(access, catalogId), id, user.id);
  }

  @Post('imports/:importId/discard')
  @HttpCode(HttpStatus.OK)
  async discard(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
  ) {
    const id = parseOrBadRequest(importIdSchema, importId, 'importId');
    return this.catalog.discard(await this.ref(access, catalogId), id);
  }

  @Get('items')
  async items(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Query() query: unknown,
  ) {
    const filters = parseOrBadRequest(itemsQuerySchema, query, 'query');
    return this.catalog.listItems(await this.ref(access, catalogId), filters);
  }

  @Put('items/:externalId')
  async putItem(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Param('externalId') externalId: string,
    @Body() body: unknown,
  ) {
    const code = parseOrBadRequest(externalIdSchema, externalId, 'externalId');
    const item = parseOrBadRequest(itemBodySchema, body ?? {}, 'body');
    return this.catalog.putItem(await this.ref(access, catalogId), code, item);
  }

  /** Marks the item unavailable ("agotado"). */
  @Delete('items/:externalId')
  async removeItem(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Param('externalId') externalId: string,
  ) {
    const code = parseOrBadRequest(externalIdSchema, externalId, 'externalId');
    return this.catalog.removeItem(await this.ref(access, catalogId), code);
  }

  /** The catalog's Google Sheet published as CSV and its last sync. */
  @Get('sheet')
  async sheet(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
  ) {
    return this.sheets.get(await this.ref(access, catalogId));
  }

  /** `{ url }` (null removes it); the first sync runs right away. */
  @Put('sheet')
  async putSheet(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @Body() body: unknown,
  ) {
    const { url } = parseOrBadRequest(sheetBodySchema, body ?? {}, 'body');
    const view = await this.sheets.set(await this.ref(access, catalogId), url);
    this.scheduler.schedule();
    return view;
  }

  /** "Sincronizar ahora". */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync(
    @CurrentBusiness() access: BusinessAccess,
    @Param('catalogId') catalogId: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sheets.sync(await this.ref(access, catalogId), user.id);
  }

  /** The catalog in the path, or the first one on the old routes. */
  private ref(
    access: BusinessAccess,
    catalogId: string | undefined,
  ): Promise<CatalogRef> {
    return this.catalogs.resolve(
      access.businessId,
      catalogId === undefined
        ? undefined
        : parseOrBadRequest(catalogIdSchema, catalogId, 'catalogId'),
    );
  }
}
