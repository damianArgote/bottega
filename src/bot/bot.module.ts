import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { ContentModule } from '../content/content.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { BotService } from './bot.service.js';
import { CommandService } from './command.service.js';
import {
  EchoReplyGenerator,
  REPLY_GENERATOR,
  UnimplementedAiReplyGenerator,
  type ReplyGenerator,
} from './reply-generator.js';
import { BotWorker } from './worker.js';

@Module({
  imports: [QueueModule, WhatsAppModule, ConversationsModule, ContentModule],
  providers: [
    BotService,
    BotWorker,
    CommandService,
    {
      provide: REPLY_GENERATOR,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): ReplyGenerator =>
        config.get('BOT_REPLY_MODE') === 'ai'
          ? new UnimplementedAiReplyGenerator()
          : new EchoReplyGenerator(),
    },
  ],
  exports: [BotService, BotWorker],
})
export class BotModule {}
