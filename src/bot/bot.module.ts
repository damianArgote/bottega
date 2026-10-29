import { Module } from '@nestjs/common';
import { AI_PROVIDER, type AiProvider } from '../ai/ai.provider.js';
import { AiModule } from '../ai/ai.module.js';
import { AiLimitsService } from '../ai/ai-limits.service.js';
import { MediaModule } from '../media/media.module.js';
import { AttachmentPreparer } from './attachment-preparer.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { ContentModule } from '../content/content.module.js';
import { ContentService } from '../content/content.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { DemosModule } from '../demos/demos.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PushModule } from '../push/push.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { AiReplyGenerator } from './ai-reply-generator.js';
import { BotService } from './bot.service.js';
import { CommandService } from './command.service.js';
import {
  EchoReplyGenerator,
  REPLY_GENERATOR,
  type ReplyGenerator,
} from './reply-generator.js';
import { ToolEffectsService } from './tools/tool-effects.service.js';
import { BotWorker } from './worker.js';

@Module({
  imports: [
    QueueModule,
    CatalogModule,
    WhatsAppModule,
    ConversationsModule,
    ContentModule,
    LeadsModule,
    DemosModule,
    AiModule,
    MediaModule,
    PushModule,
  ],
  providers: [
    BotService,
    BotWorker,
    CommandService,
    ToolEffectsService,
    AttachmentPreparer,
    {
      provide: REPLY_GENERATOR,
      inject: [
        AppConfigService,
        AI_PROVIDER,
        AiUsageService,
        PrismaService,
        ContentService,
        AiLimitsService,
        CatalogService,
      ],
      useFactory: (
        config: AppConfigService,
        provider: AiProvider,
        usage: AiUsageService,
        prisma: PrismaService,
        content: ContentService,
        limits: AiLimitsService,
        catalog: CatalogService,
      ): ReplyGenerator =>
        config.get('BOT_REPLY_MODE') === 'ai'
          ? new AiReplyGenerator({
              provider,
              usage,
              limits,
              catalog,
              prisma,
              content,
              config,
            })
          : new EchoReplyGenerator(),
    },
  ],
  exports: [BotService, BotWorker],
})
export class BotModule {}
