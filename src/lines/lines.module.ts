import { Module } from '@nestjs/common';
import { LineCredentialsService } from './line-credentials.service.js';
import { LinesService } from './lines.service.js';

/** Businesses and their WhatsApp lines (one Meta app per business). */
@Module({
  providers: [LineCredentialsService, LinesService],
  exports: [LineCredentialsService, LinesService],
})
export class LinesModule {}
