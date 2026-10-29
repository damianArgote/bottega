import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { CatalogAiService } from './catalog-ai.service.js';
import { CatalogService } from './catalog.service.js';

/** A business's catalog: imports, items and the bot's search. */
@Module({
  imports: [AiModule],
  providers: [CatalogService, CatalogAiService],
  exports: [CatalogService],
})
export class CatalogModule {}
