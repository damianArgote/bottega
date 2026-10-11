import { Module } from '@nestjs/common';
import { LeadsService } from './leads.service.js';

@Module({
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
