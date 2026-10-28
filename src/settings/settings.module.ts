import { Module } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service.js';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { InMemoryLoginRateLimiter } from '../auth/login-rate-limiter.js';
import { AgentPreviewService } from '../bot/agent-preview.service.js';
import { ContentModule } from '../content/content.module.js';
import { LeadsQueryService } from '../leads/leads-query.service.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { LeadsController } from './leads.controller.js';
import { WhatsAppSettingsController } from './whatsapp-settings.controller.js';
import {
  PREVIEW_RATE_LIMITER,
  SettingsController,
} from './settings.controller.js';

/** The backoffice API (business OWNERs): agent, leads and WhatsApp connection. */
@Module({
  imports: [AiModule, AuthModule, ContentModule, OnboardingModule],
  controllers: [
    SettingsController,
    LeadsController,
    WhatsAppSettingsController,
  ],
  providers: [
    AgentsService,
    AgentPreviewService,
    LeadsQueryService,
    BusinessAccessGuard,
    {
      provide: PREVIEW_RATE_LIMITER,
      // 20 previews per hour per business (in memory, one instance).
      useValue: new InMemoryLoginRateLimiter({
        max: 20,
        windowMs: 60 * 60_000,
      }),
    },
  ],
})
export class SettingsModule {}
