import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LinesModule } from '../lines/lines.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { AdminApiKeyGuard } from './admin-api-key.guard.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { BusinessesService } from './businesses.service.js';

@Module({
  imports: [ConversationsModule, LinesModule, WhatsAppModule],
  controllers: [AdminController],
  providers: [AdminService, BusinessesService, AdminApiKeyGuard],
})
export class AdminModule {}
