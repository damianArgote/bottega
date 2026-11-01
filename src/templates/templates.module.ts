import { Module } from '@nestjs/common';
import { LinesModule } from '../lines/lines.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { TemplatesSyncScheduler } from './templates-sync.scheduler.js';
import { TemplatesService } from './templates.service.js';

/** WhatsApp message templates: copied from Meta daily and on demand. */
@Module({
  imports: [LinesModule, WhatsAppModule],
  providers: [TemplatesService, TemplatesSyncScheduler],
  exports: [TemplatesService, TemplatesSyncScheduler],
})
export class TemplatesModule {}
