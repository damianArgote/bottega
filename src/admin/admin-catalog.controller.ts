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
  itemsQuerySchema,
  parseImportRequest,
} from '../catalog/catalog.schemas.js';
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
  constructor(private readonly catalog: CatalogService) {}

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
}
