import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LinesModule } from '../lines/lines.module.js';
import { GraphWhatsAppClient } from './graph-whatsapp.client.js';
import { LineSignatureGuard } from './line-signature.guard.js';
import { WhatsAppSignatureGuard } from './signature.guard.js';
import { WebhookEventProcessor } from './webhook-event-processor.js';
import { WebhookEventsService } from './webhook-events.service.js';
import { WebhookReprocessor } from './webhook-reprocessor.js';
import { WhatsAppWebhookController } from './webhook.controller.js';
import { LineWhatsAppClientFactory } from './line-client.factory.js';
import { WHATSAPP_CLIENT_FACTORY } from './whatsapp.client.js';

@Module({
  imports: [ConversationsModule, LinesModule],
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppSignatureGuard,
    LineSignatureGuard,
    WebhookEventProcessor,
    WebhookReprocessor,
    WebhookEventsService,
    {
      provide: GraphWhatsAppClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new GraphWhatsAppClient({
          apiVersion: config.get('WHATSAPP_GRAPH_API_VERSION'),
          timeoutMs: config.get('WHATSAPP_HTTP_TIMEOUT_MS'),
        }),
    },
    { provide: WHATSAPP_CLIENT_FACTORY, useClass: LineWhatsAppClientFactory },
  ],
  exports: [WHATSAPP_CLIENT_FACTORY, GraphWhatsAppClient],
})
export class WhatsAppModule {}
