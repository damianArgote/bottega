import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module.js';
import { AppConfigModule } from './config/app-config.module.js';
import { ContentModule } from './content/content.module.js';
import { DemosModule } from './demos/demos.module.js';
import { HealthModule } from './health/health.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WhatsAppModule } from './whatsapp/whatsapp.module.js';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    ContentModule,
    HealthModule,
    WhatsAppModule,
    BotModule,
    LeadsModule,
    DemosModule,
  ],
})
export class AppModule {}
