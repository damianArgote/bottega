import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../admin/admin-api-key.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessAccessGuard } from '../auth/business-access.guard.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { LinesModule } from '../lines/lines.module.js';
import {
  AdminPaymentAccountsController,
  StaffPaymentAccountsController,
} from './payment-accounts.controllers.js';
import { PaymentAccountsService } from './payment-accounts.service.js';
import { InboxPaymentsController } from './inbox-payments.controller.js';
import { InboxPaymentsService } from './inbox-payments.service.js';
import { PaymentExpiryScheduler } from './payment-expiry.scheduler.js';
import { PaymentWebhookController } from './payment-webhook.controller.js';
import { PaymentsService } from './payments.service.js';
import {
  MercadoPagoProvider,
  PAYMENT_FETCH,
} from './providers/mercadopago.provider.js';
import { TransferProvider } from './providers/transfer.provider.js';

/**
 * Payments (prompt 07c): each business's accounts and the charges made with
 * them. The core never knows the provider: each one is an adapter.
 */
@Module({
  imports: [AuthModule, LinesModule, ConversationsModule, InboxModule],
  controllers: [
    AdminPaymentAccountsController,
    StaffPaymentAccountsController,
    PaymentWebhookController,
    InboxPaymentsController,
  ],
  providers: [
    PaymentAccountsService,
    PaymentsService,
    PaymentExpiryScheduler,
    MercadoPagoProvider,
    TransferProvider,
    InboxPaymentsService,
    AdminApiKeyGuard,
    BusinessAccessGuard,
    {
      provide: PAYMENT_FETCH,
      useValue: ((input, init) => fetch(input, init)) as typeof fetch,
    },
  ],
  exports: [PaymentAccountsService, PaymentsService],
})
export class PaymentsModule {}
