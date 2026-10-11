import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { DemosService } from './demos.service.js';

@Module({
  imports: [ContentModule],
  providers: [DemosService],
  exports: [DemosService],
})
export class DemosModule {}
