import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module.js';
import { AppConfigModule } from './config/app-config.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WhatsAppModule } from './whatsapp/whatsapp.module.js';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    HealthModule,
    WhatsAppModule,
    BotModule,
  ],
})
export class AppModule {}
