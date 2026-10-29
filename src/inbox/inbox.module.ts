import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { ConversationActionsService } from './conversation-actions.service.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { HumanRepliesService } from './human-replies.service.js';
import { MediaModule } from '../media/media.module.js';
import { InboxController } from './inbox.controller.js';
import { MediaProxyController } from './media-proxy.controller.js';
import { InboxMessagesService } from './inbox-messages.service.js';
import { InboxQueriesService } from './inbox-queries.service.js';
import { InboxService } from './inbox.service.js';

@Module({
  imports: [AuthModule, WhatsAppModule, MediaModule],
  controllers: [InboxController, MediaProxyController],
  providers: [
    InboxService,
    ConversationActionsService,
    InboxQueriesService,
    InboxMessagesService,
    HumanRepliesService,
    BusinessAccessGuard,
  ],
})
export class InboxModule {}
