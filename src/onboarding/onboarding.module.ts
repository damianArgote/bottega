import { Module } from '@nestjs/common';
import { LinesModule } from '../lines/lines.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { LineOnboardingService } from './line-onboarding.service.js';

/** Step-by-step onboarding of a line with Meta (admin and inbox routes). */
@Module({
  imports: [LinesModule, WhatsAppModule],
  providers: [LineOnboardingService],
  exports: [LineOnboardingService],
})
export class OnboardingModule {}
