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
import { AdminApiKeyGuard } from './admin-api-key.guard.js';
import { businessIdSchema, parseOrBadRequest } from './admin.schemas.js';

/** A business's catalogs through the admin API: list, create, edit, delete. */
@Controller('admin/businesses/:id/catalogs')
@UseGuards(AdminApiKeyGuard)
export class AdminCatalogsController {
  constructor(private readonly catalogs: CatalogsService) {}

  @Get()
  list(@Param('id') id: string) {
    return this.catalogs.list(parseOrBadRequest(businessIdSchema, id, 'id'));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Param('id') id: string, @Body() body: unknown) {
    const businessId = parseOrBadRequest(businessIdSchema, id, 'id');
    const { name } = parseOrBadRequest(newCatalogSchema, body ?? {}, 'body');
    return this.catalogs.create(businessId, name);
  }

  @Patch(':catalogId')
  async update(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string,
    @Body() body: unknown,
  ) {
    const changes = parseOrBadRequest(catalogChangesSchema, body ?? {}, 'body');
    return this.catalogs.update(
      await this.catalogs.resolve(
        parseOrBadRequest(businessIdSchema, id, 'id'),
        parseOrBadRequest(catalogIdSchema, catalogId, 'catalogId'),
      ),
      changes,
    );
  }

  /** Deletes the catalog and its items (409 LAST_CATALOG for the only one). */
  @Delete(':catalogId')
  async remove(@Param('id') id: string, @Param('catalogId') catalogId: string) {
    return this.catalogs.remove(
      await this.catalogs.resolve(
        parseOrBadRequest(businessIdSchema, id, 'id'),
        parseOrBadRequest(catalogIdSchema, catalogId, 'catalogId'),
      ),
    );
  }
}

/**
 * One catalog of a business through the admin API: imports (preview, then
 * apply) and single items by code, for the clients' own systems.
 * `.../catalog/...` (the routes before several catalogs existed, still used
 * by those systems) acts on the business's first catalog.
 */
@Controller([
  'admin/businesses/:id/catalog',
  'admin/businesses/:id/catalogs/:catalogId',
])
@UseGuards(AdminApiKeyGuard)
export class AdminCatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly catalogs: CatalogsService,
    private readonly sheets: CatalogSheetService,
    private readonly scheduler: CatalogSyncScheduler,
  ) {}

  /** A `text/csv` body (mapping in `?mapping=`) or `{ rows, mapping }`. */
  @Post('imports')
  @HttpCode(HttpStatus.CREATED)
  async createImport(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
    @Query('mapping') mapping: unknown,
  ) {
    const source = parseImportRequest(contentType, body, mapping);
    return this.catalog.preview(await this.ref(id, catalogId), source, null);
  }

  @Get('imports/:importId')
  async getImport(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
  ) {
    const importRef = parseOrBadRequest(importIdSchema, importId, 'importId');
    return this.catalog.getImport(await this.ref(id, catalogId), importRef);
  }

  /** Confirms or corrects the column mapping of a preview. */
  @Put('imports/:importId/mapping')
  async confirmMapping(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ) {
    const importRef = parseOrBadRequest(importIdSchema, importId, 'importId');
    const { mapping } = parseOrBadRequest(
      mappingBodySchema,
      body ?? {},
      'body',
    );
    return this.catalog.confirmMapping(
      await this.ref(id, catalogId),
      importRef,
      mapping,
    );
  }

  @Post('imports/:importId/apply')
  @HttpCode(HttpStatus.OK)
  async apply(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
  ) {
    const importRef = parseOrBadRequest(importIdSchema, importId, 'importId');
    return this.catalog.apply(await this.ref(id, catalogId), importRef, null);
  }

  @Post('imports/:importId/discard')
  @HttpCode(HttpStatus.OK)
  async discard(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Param('importId') importId: string,
  ) {
    const importRef = parseOrBadRequest(importIdSchema, importId, 'importId');
    return this.catalog.discard(await this.ref(id, catalogId), importRef);
  }

  @Get('items')
  async items(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Query() query: unknown,
  ) {
    const filters = parseOrBadRequest(itemsQuerySchema, query, 'query');
    return this.catalog.listItems(await this.ref(id, catalogId), filters);
  }

  /** Creates or updates one item by its code. */
  @Put('items/:externalId')
  async putItem(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Param('externalId') externalId: string,
    @Body() body: unknown,
  ) {
    const code = parseOrBadRequest(externalIdSchema, externalId, 'externalId');
    const item = parseOrBadRequest(itemBodySchema, body ?? {}, 'body');
    return this.catalog.putItem(await this.ref(id, catalogId), code, item);
  }

  /** Marks the item unavailable (never deleted). */
  @Delete('items/:externalId')
  async removeItem(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Param('externalId') externalId: string,
  ) {
    const code = parseOrBadRequest(externalIdSchema, externalId, 'externalId');
    return this.catalog.removeItem(await this.ref(id, catalogId), code);
  }

  /** The catalog's Google Sheet published as CSV and its last sync. */
  @Get('sheet')
  async sheet(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
  ) {
    return this.sheets.get(await this.ref(id, catalogId));
  }

  /** `{ url }` (null removes it); the first sync runs right away. */
  @Put('sheet')
  async putSheet(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
    @Body() body: unknown,
  ) {
    const { url } = parseOrBadRequest(sheetBodySchema, body ?? {}, 'body');
    const view = await this.sheets.set(await this.ref(id, catalogId), url);
    this.scheduler.schedule();
    return view;
  }

  /** "Sincronizar ahora". */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync(
    @Param('id') id: string,
    @Param('catalogId') catalogId: string | undefined,
  ) {
    return this.sheets.sync(await this.ref(id, catalogId), null);
  }

  /** The catalog in the path, or the first one on the old routes. */
  private ref(id: string, catalogId: string | undefined): Promise<CatalogRef> {
    return this.catalogs.resolve(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      catalogId === undefined
        ? undefined
        : parseOrBadRequest(catalogIdSchema, catalogId, 'catalogId'),
    );
  }
}
