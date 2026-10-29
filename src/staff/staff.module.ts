import { Module } from '@nestjs/common';
import { BusinessesService } from '../admin/businesses.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { LinesModule } from '../lines/lines.module.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { StaffController } from './staff.controller.js';

/** The BotSuite46 team's client onboarding from the inbox (`/staff`). */
@Module({
  imports: [AuthModule, LinesModule, OnboardingModule, WhatsAppModule],
  controllers: [StaffController],
  providers: [BusinessesService],
})
export class StaffModule {}
