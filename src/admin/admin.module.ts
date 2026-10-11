import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { AdminApiKeyGuard } from './admin-api-key.guard.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [ConversationsModule, WhatsAppModule],
  controllers: [AdminController],
  providers: [AdminService, AdminApiKeyGuard],
})
export class AdminModule {}
