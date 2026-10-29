import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import {
  AI_PROVIDER,
  AiProviderError,
  type AiProvider,
} from './ai.provider.js';
import { AiLimitsService } from './ai-limits.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { OpenAiProvider } from './openai.provider.js';

/** Used in echo mode, where no API key is configured and no call is made. */
const disabledProvider: AiProvider = {
  respond: () => Promise.reject(new AiProviderError('ai_disabled', false)),
};

@Module({
  providers: [
    AiUsageService,
    AiLimitsService,
    {
      provide: AI_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): AiProvider => {
        const apiKey = config.get('OPENAI_API_KEY');
        // The model goes in each request (the business's profile may set one).
        if (
          config.get('BOT_REPLY_MODE') !== 'ai' ||
          !apiKey ||
          !config.get('OPENAI_MODEL')
        ) {
          return disabledProvider;
        }
        return new OpenAiProvider({
          apiKey,
          timeoutMs: config.get('OPENAI_TIMEOUT_MS'),
        });
      },
    },
  ],
  exports: [AI_PROVIDER, AiUsageService, AiLimitsService],
})
export class AiModule {}
