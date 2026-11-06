import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../admin/admin-api-key.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { LinesModule } from '../lines/lines.module.js';
import {
  AdminPaymentAccountsController,
  StaffPaymentAccountsController,
} from './payment-accounts.controllers.js';
import { PaymentAccountsService } from './payment-accounts.service.js';

/**
 * Payments (prompt 07c): each business's accounts and the charges made with
 * them. The core never knows the provider: each one is an adapter.
 */
@Module({
  imports: [AuthModule, LinesModule],
  controllers: [AdminPaymentAccountsController, StaffPaymentAccountsController],
  providers: [PaymentAccountsService, AdminApiKeyGuard],
  exports: [PaymentAccountsService],
})
export class PaymentsModule {}
