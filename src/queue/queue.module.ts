import { Module } from '@nestjs/common';
import { QueueSignal } from './queue-signal.js';
import { QueueService } from './queue.service.js';

@Module({
  providers: [QueueService, QueueSignal],
  exports: [QueueService, QueueSignal],
})
export class QueueModule {}
