import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import {
  IntegrationBusiness,
  IntegrationKeyGuard,
} from './integration-key.guard.js';
import {
  IntegrationsReadService,
  readQuerySchema,
} from './integrations-read.service.js';

/**
 * Read-only API for n8n and the businesses' own systems, with an
 * integration key (`X-Api-Key` or `Authorization: Bearer`). Every route only
 * sees the key's business.
 */
@Controller('integrations/v1')
@UseGuards(IntegrationKeyGuard)
export class IntegrationsApiController {
  constructor(private readonly read: IntegrationsReadService) {}

  /** `?updatedSince=&cursor=`: `{ data, nextCursor }`, 100 a page. */
  @Get('leads')
  leads(@IntegrationBusiness() businessId: string, @Query() query: unknown) {
    return this.read.leads(
      businessId,
      parseOrBadRequest(readQuerySchema, query, 'query'),
    );
  }

  /** `?updatedSince=&cursor=`: `{ data, nextCursor }`, without messages. */
  @Get('conversations')
  conversations(
    @IntegrationBusiness() businessId: string,
    @Query() query: unknown,
  ) {
    return this.read.conversations(
      businessId,
      parseOrBadRequest(readQuerySchema, query, 'query'),
    );
  }
}
