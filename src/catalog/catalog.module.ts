import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

/** A business's catalog: imports, items and the bot's search. */
@Module({
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
