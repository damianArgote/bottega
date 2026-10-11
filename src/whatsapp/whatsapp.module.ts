import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { GraphWhatsAppClient } from './graph-whatsapp.client.js';
import { InboundDispatcher } from './inbound.dispatcher.js';
import { WhatsAppSignatureGuard } from './signature.guard.js';
import { WhatsAppWebhookController } from './webhook.controller.js';
import { WHATSAPP_CLIENT, type WhatsAppClient } from './whatsapp.client.js';

@Module({
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppSignatureGuard,
    InboundDispatcher,
    {
      provide: WHATSAPP_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): WhatsAppClient =>
        new GraphWhatsAppClient({
          accessToken: config.get('WHATSAPP_ACCESS_TOKEN'),
          phoneNumberId: config.get('WHATSAPP_PHONE_NUMBER_ID'),
          apiVersion: config.get('WHATSAPP_GRAPH_API_VERSION'),
          timeoutMs: config.get('WHATSAPP_HTTP_TIMEOUT_MS'),
        }),
    },
  ],
  exports: [WHATSAPP_CLIENT, InboundDispatcher],
})
export class WhatsAppModule {}
