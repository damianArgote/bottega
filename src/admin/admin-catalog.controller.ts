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
import { AdminApiKeyGuard } from './admin-api-key.guard.js';
import { businessIdSchema, parseOrBadRequest } from './admin.schemas.js';

/**
 * A business's catalog through the admin API: imports (preview, then apply)
 * and single items by code, for the clients' own systems.
 */
@Controller('admin/businesses/:id/catalog')
@UseGuards(AdminApiKeyGuard)
export class AdminCatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly sheets: CatalogSheetService,
    private readonly scheduler: CatalogSyncScheduler,
  ) {}

  /** A `text/csv` body (mapping in `?mapping=`) or `{ rows, mapping }`. */
  @Post('imports')
  @HttpCode(HttpStatus.CREATED)
  createImport(
    @Param('id') id: string,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
    @Query('mapping') mapping: unknown,
  ) {
    return this.catalog.preview(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseImportRequest(contentType, body, mapping),
      null,
    );
  }

  @Get('imports/:importId')
  getImport(@Param('id') id: string, @Param('importId') importId: string) {
    return this.catalog.getImport(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(importIdSchema, importId, 'importId'),
    );
  }

  /** Confirms or corrects the column mapping of a preview. */
  @Put('imports/:importId/mapping')
  confirmMapping(
    @Param('id') id: string,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.confirmMapping(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(importIdSchema, importId, 'importId'),
      parseOrBadRequest(mappingBodySchema, body ?? {}, 'body').mapping,
    );
  }

  @Post('imports/:importId/apply')
  @HttpCode(HttpStatus.OK)
  apply(@Param('id') id: string, @Param('importId') importId: string) {
    return this.catalog.apply(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(importIdSchema, importId, 'importId'),
      null,
    );
  }

  @Post('imports/:importId/discard')
  @HttpCode(HttpStatus.OK)
  discard(@Param('id') id: string, @Param('importId') importId: string) {
    return this.catalog.discard(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(importIdSchema, importId, 'importId'),
    );
  }

  @Get('items')
  items(@Param('id') id: string, @Query() query: unknown) {
    return this.catalog.listItems(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(itemsQuerySchema, query, 'query'),
    );
  }

  /** Creates or updates one item by its code. */
  @Put('items/:externalId')
  putItem(
    @Param('id') id: string,
    @Param('externalId') externalId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.putItem(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(externalIdSchema, externalId, 'externalId'),
      parseOrBadRequest(itemBodySchema, body ?? {}, 'body'),
    );
  }

  /** Marks the item unavailable (never deleted). */
  @Delete('items/:externalId')
  removeItem(@Param('id') id: string, @Param('externalId') externalId: string) {
    return this.catalog.removeItem(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(externalIdSchema, externalId, 'externalId'),
    );
  }

  /** The Google Sheet published as CSV and its last sync. */
  @Get('sheet')
  sheet(@Param('id') id: string) {
    return this.sheets.get(parseOrBadRequest(businessIdSchema, id, 'id'));
  }

  /** `{ url }` (null removes it); the first sync runs right away. */
  @Put('sheet')
  async putSheet(@Param('id') id: string, @Body() body: unknown) {
    const view = await this.sheets.set(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      parseOrBadRequest(sheetBodySchema, body ?? {}, 'body').url,
    );
    this.scheduler.schedule();
    return view;
  }

  /** "Sincronizar ahora". */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(@Param('id') id: string) {
    return this.sheets.sync(
      parseOrBadRequest(businessIdSchema, id, 'id'),
      null,
    );
  }
}
