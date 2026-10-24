import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { ContextService } from './context.service.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [QueueModule],
  providers: [ConversationsService, ContextService],
  exports: [ConversationsService, ContextService],
})
export class ConversationsModule {}
