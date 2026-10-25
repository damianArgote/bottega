import { Module } from '@nestjs/common';
import { LineCredentialsService } from './line-credentials.service.js';

/** Businesses and their WhatsApp lines (one Meta app per business). */
@Module({
  providers: [LineCredentialsService],
  exports: [LineCredentialsService],
})
export class LinesModule {}
