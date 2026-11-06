import { Injectable } from '@nestjs/common';
import {
  PaymentProviderError,
  type PaymentLink,
  type PaymentProvider,
  type ProviderPayment,
} from './payment-provider.js';

/**
 * A bank transfer: no link, no notification, nothing to look up. The bot
 * sends the alias or CBU, and only a person marks it paid.
 */
@Injectable()
export class TransferProvider implements PaymentProvider {
  createLink(): Promise<PaymentLink> {
    return Promise.resolve({ url: null, providerRef: null });
  }

  verifyNotification(): string | null {
    return null;
  }

  fetchPayment(): Promise<ProviderPayment> {
    return Promise.reject(new PaymentProviderError('not_supported'));
  }
}
