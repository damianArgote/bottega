import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../admin/admin-api-key.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { createSafeFetch } from '../integrations/safe-fetch.js';
import { LinesModule } from '../lines/lines.module.js';
import {
  ACTION_FETCH,
  ACTION_RESPONSE_MAX_BYTES,
  ActionCallerService,
} from './action-caller.service.js';
import {
  AdminActionsController,
  OwnerActionsController,
  StaffActionsController,
} from './agent-actions.controllers.js';
import { AgentActionsService } from './agent-actions.service.js';

/**
 * Business actions (prompt 07b): tools a business adds to its agent,
 * resolved by n8n or its own service through a signed POST.
 */
@Module({
  imports: [AuthModule, LinesModule],
  controllers: [
    AdminActionsController,
    StaffActionsController,
    OwnerActionsController,
  ],
  providers: [
    AgentActionsService,
    ActionCallerService,
    AdminApiKeyGuard,
    BusinessAccessGuard,
    {
      provide: ACTION_FETCH,
      useValue: createSafeFetch({ maxResponseBytes: ACTION_RESPONSE_MAX_BYTES }),
    },
  ],
  exports: [AgentActionsService, ActionCallerService],
})
export class ActionsModule {}
