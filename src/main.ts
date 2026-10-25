import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureHttp } from './app.setup.js';
import { AppConfigService } from './config/app-config.service.js';

async function bootstrap(): Promise<void> {
  // Env validation runs while AppModule is created: an invalid environment
  // throws EnvValidationError (names and rules only, never values) and Nest
  // aborts the boot with a non-zero exit code.
  // rawBody is required to verify the WhatsApp webhook signature (Stage 2).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  configureHttp(app, config);

  const port = config.get('PORT');
  await app.listen(port);
  Logger.log(`bottega-api listening on port ${port}`, 'Bootstrap');
}

await bootstrap();
