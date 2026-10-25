import { Module } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service.js';
import { AiModule } from '../ai/ai.module.js';
import { AgentPreviewService } from '../bot/agent-preview.service.js';
import { ContentModule } from '../content/content.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LinesModule } from '../lines/lines.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { AdminApiKeyGuard } from './admin-api-key.guard.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { BusinessesService } from './businesses.service.js';

@Module({
  imports: [
    AiModule,
    ContentModule,
    ConversationsModule,
    LinesModule,
    WhatsAppModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    AgentPreviewService,
    AgentsService,
    BusinessesService,
    AdminApiKeyGuard,
  ],
})
export class AdminModule {}
