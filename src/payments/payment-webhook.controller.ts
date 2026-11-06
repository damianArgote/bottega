import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PaymentProviderKind } from '../generated/prisma/client.js';
import { PaymentsService } from './payments.service.js';

/**
 * Payment providers' notifications (prompt 07c). The key in the route picks
 * the business's account; the signature is checked with its secret. A
 * notification never confirms by itself: the payment is looked up. Answers
 * 200 when there is nothing (else) to do, 404 for an unknown key and 502
 * when the lookup failed (the provider retries).
 */
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('mercadopago/:webhookKey')
  @HttpCode(HttpStatus.OK)
  async mercadoPago(
    @Param('webhookKey') webhookKey: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    await this.payments.handleNotification(
      PaymentProviderKind.mercadopago,
      webhookKey,
      { headers, query, body },
    );
    return { ok: true };
  }
}
