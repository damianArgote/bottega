import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service.js';

@Module({
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
