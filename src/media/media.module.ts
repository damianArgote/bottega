import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { LinesModule } from '../lines/lines.module.js';
import { LineMediaSource, MEDIA_SOURCE } from './line-media.service.js';
import { MetaMediaClient } from './meta-media.client.js';

/** Inbound attachments in Meta, fetched with each line's token. */
@Module({
  imports: [LinesModule],
  providers: [
    {
      provide: MetaMediaClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new MetaMediaClient({
          apiVersion: config.get('WHATSAPP_GRAPH_API_VERSION'),
          timeoutMs: config.get('WHATSAPP_HTTP_TIMEOUT_MS'),
        }),
    },
    { provide: MEDIA_SOURCE, useClass: LineMediaSource },
  ],
  exports: [MEDIA_SOURCE],
})
export class MediaModule {}
