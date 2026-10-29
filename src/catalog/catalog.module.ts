import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { CatalogAiService } from './catalog-ai.service.js';
import { CatalogSheetService } from './catalog-sheet.service.js';
import { CatalogSyncScheduler } from './catalog-sync.scheduler.js';
import { CatalogService } from './catalog.service.js';
import { httpSheetFetcher, SHEET_FETCHER } from './sheet-fetcher.js';

/**
 * A business's catalog: imports (files, JSON, documents, its Google Sheet),
 * items, the hourly sheet sync and the bot's search.
 */
@Module({
  imports: [AiModule],
  providers: [
    CatalogService,
    CatalogAiService,
    CatalogSheetService,
    CatalogSyncScheduler,
    { provide: SHEET_FETCHER, useValue: httpSheetFetcher() },
  ],
  exports: [CatalogService, CatalogSheetService, CatalogSyncScheduler],
})
export class CatalogModule {}
