import { createSafeFetch } from './safe-fetch.js';
import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../admin/admin-api-key.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { LinesModule } from '../lines/lines.module.js';
import { WEBHOOK_JOB_PROCESSOR } from '../queue/push-jobs.js';
import { IntegrationKeyGuard } from './integration-key.guard.js';
import {
  AdminIntegrationsController,
  StaffIntegrationsController,
} from './integrations-admin.controllers.js';
import { IntegrationsApiController } from './integrations-api.controller.js';
import { IntegrationsReadService } from './integrations-read.service.js';
import { IntegrationsService } from './integrations.service.js';
import {
  WEBHOOK_FETCH,
  WEBHOOK_SAFE_FETCH_OPTIONS,
  WebhookDeliveryService,
} from './webhook-delivery.service.js';

/**
 * Integrations with n8n and the businesses' own systems: signed webhook
 * events (sent by the queue worker), the read-only /integrations/v1 API
 * and their admin and staff routes.
 */
@Module({
  imports: [AuthModule, LinesModule],
  controllers: [
    IntegrationsApiController,
    AdminIntegrationsController,
    StaffIntegrationsController,
  ],
  providers: [
    IntegrationsService,
    IntegrationsReadService,
    IntegrationKeyGuard,
    AdminApiKeyGuard,
    WebhookDeliveryService,
    {
      provide: WEBHOOK_FETCH,
      useValue: createSafeFetch(WEBHOOK_SAFE_FETCH_OPTIONS),
    },
    { provide: WEBHOOK_JOB_PROCESSOR, useExisting: WebhookDeliveryService },
  ],
  exports: [WEBHOOK_JOB_PROCESSOR],
})
export class IntegrationsModule {}
