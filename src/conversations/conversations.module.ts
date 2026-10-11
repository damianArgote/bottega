import { Module } from '@nestjs/common';
import { ContextService } from './context.service.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  providers: [ConversationsService, ContextService],
  exports: [ConversationsService, ContextService],
})
export class ConversationsModule {}
