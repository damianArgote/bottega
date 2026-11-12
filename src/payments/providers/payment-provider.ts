import type { MercadoPagoCredentials } from '../payment-accounts.service.js';

/** What a provider needs of an account (credentials already decrypted). */
export interface ProviderAccount {
  id: string;
  /** Mercado Pago only; null for providers without credentials. */
  credentials: MercadoPagoCredentials | null;
}

/** The charge a link is created for. */
export interface LinkRequest {
  /** Our payment id: the provider's external reference. */
  id: string;
  concept: string;
  amountArs: number;
  expiresAt: Date;
  /** Where the provider notifies payments; null when it has none. */
  notificationUrl: string | null;
}

export interface PaymentLink {
  /** Null for a provider without links (a transfer). */
  url: string | null;
  /** The provider's own id for the link (a Mercado Pago preference). */
  providerRef: string | null;
}

/** A provider's notification as it arrived (never trusted as is). */
export interface NotificationRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
}

/** A payment as the provider reports it when asked. */
export interface ProviderPayment {
  status: 'approved' | 'rejected' | 'pending';
  /** Paid amount in pesos (may have cents). */
  amountArs: number;
  currency: string | null;
  /** Our payment id, as sent when the link was created. */
  reference: string | null;
  approvedAt: Date | null;
}

/**
 * A payment provider (prompt 07c). Adding one is adding an adapter and its
 * tests; the rest of the code never knows which provider it talks to.
 */
export interface PaymentProvider {
  createLink(
    account: ProviderAccount,
    payment: LinkRequest,
  ): Promise<PaymentLink>;
  /**
   * The provider's payment id of a notification whose signature is valid
   * and that is about a payment; null otherwise (nothing to do).
   */
  verifyNotification(
    account: ProviderAccount,
    request: NotificationRequest,
  ): string | null;
  fetchPayment(account: ProviderAccount, id: string): Promise<ProviderPayment>;
}

/** A provider call that failed; `code` is content-free (`http_401`, `timeout`). */
export class PaymentProviderError extends Error {
  constructor(readonly code: string) {
    super(`Payment provider error: ${code}`);
    this.name = 'PaymentProviderError';
  }
}
