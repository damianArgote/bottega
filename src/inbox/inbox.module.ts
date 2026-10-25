import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { ConversationActionsService } from './conversation-actions.service.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

@Module({
  imports: [AuthModule],
  controllers: [InboxController],
  providers: [InboxService, ConversationActionsService, BusinessAccessGuard],
})
export class InboxModule {}
