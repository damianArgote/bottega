import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import { ConversationMode } from '../generated/prisma/client.js';
import type { BusinessModules } from './modules.js';

/**
 * The one place that decides which modules a business has on, and with
 * that which tools its agent gets (see MODULE_TOOLS). Modules belong to the
 * business: the fictitious demo never gets any.
 */
@Injectable()
export class BusinessModulesService {
  constructor(private readonly catalog: CatalogService) {}

  async forBusiness(
    businessId: string,
    mode: ConversationMode,
  ): Promise<BusinessModules> {
    if (mode !== ConversationMode.COMMERCIAL) {
      return {};
    }
    // catalog: on while the business has an available item.
    const catalog = await this.catalog.readerFor(businessId);
    return { ...(catalog ? { catalog } : {}) };
  }
}
