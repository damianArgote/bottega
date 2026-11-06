import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  PaymentProviderError,
  type LinkRequest,
  type NotificationRequest,
  type PaymentLink,
  type PaymentProvider,
  type ProviderAccount,
  type ProviderPayment,
} from './payment-provider.js';

export const MERCADOPAGO_API = 'https://api.mercadopago.com';
/** The fetch used to call Mercado Pago (overridden in tests). */
export const PAYMENT_FETCH = Symbol('PAYMENT_FETCH');

const TIMEOUT_MS = 10_000;

const preferenceSchema = z.object({
  id: z.string(),
  init_point: z.url(),
});
const paymentSchema = z.object({
  status: z.string(),
  transaction_amount: z.number(),
  currency_id: z.string().nullish(),
  external_reference: z.string().nullish(),
  date_approved: z.string().nullish(),
});

/**
 * Mercado Pago Checkout Pro with the business's own access token: a
 * preference per payment, signed notifications, and a payment lookup that
 * is the only thing that confirms.
 */
@Injectable()
export class MercadoPagoProvider implements PaymentProvider {
  constructor(
    @Inject(PAYMENT_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  async createLink(
    account: ProviderAccount,
    payment: LinkRequest,
  ): Promise<PaymentLink> {
    const expiresAt = payment.expiresAt.toISOString();
    const body = {
      items: [
        {
          id: payment.id,
          title: payment.concept,
          quantity: 1,
          unit_price: payment.amountArs,
          currency_id: 'ARS',
        },
      ],
      external_reference: payment.id,
      ...(payment.notificationUrl
        ? { notification_url: payment.notificationUrl }
        : {}),
      expires: true,
      expiration_date_to: expiresAt,
      // Cash methods (a ticket paid days later) expire with the link too.
      date_of_expiration: expiresAt,
    };
    const response = await this.call(account, '/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': payment.id,
      },
      body: JSON.stringify(body),
    });
    const preference = preferenceSchema.safeParse(await json(response));
    if (!preference.success) {
      throw new PaymentProviderError('invalid_response');
    }
    return {
      url: preference.data.init_point,
      providerRef: preference.data.id,
    };
  }

  /**
   * Checks `x-signature` as Mercado Pago's SDK does: HMAC-SHA256 with the
   * application's webhook secret over
   * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (a missing pair is
   * left out), compared in constant time. Only `payment` notifications
   * count.
   */
  verifyNotification(
    account: ProviderAccount,
    request: NotificationRequest,
  ): string | null {
    const secret = account.credentials?.webhookSecret;
    const signature = header(request.headers, 'x-signature');
    if (!secret || !signature) {
      return null;
    }
    const parts = new Map<string, string>();
    for (const part of signature.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        parts.set(
          part.slice(0, eq).trim().toLowerCase(),
          part.slice(eq + 1).trim(),
        );
      }
    }
    const ts = parts.get('ts');
    const received = parts.get('v1');
    if (!ts || !/^\d+$/.test(ts) || !received) {
      return null;
    }
    const dataId = text(request.query['data.id']);
    const requestId = header(request.headers, 'x-request-id');
    const manifest =
      [
        ...(dataId ? [`id:${dataId}`] : []),
        ...(requestId ? [`request-id:${requestId}`] : []),
        `ts:${ts}`,
      ].join(';') + ';';
    const expected = createHmac('sha256', secret)
      .update(manifest)
      .digest('hex');
    if (!sameText(expected, received)) {
      return null;
    }
    const body = (request.body ?? {}) as { type?: unknown };
    const topic =
      text(request.query.type) ?? text(request.query.topic) ?? text(body.type);
    return topic === 'payment' && dataId ? dataId : null;
  }

  async fetchPayment(
    account: ProviderAccount,
    id: string,
  ): Promise<ProviderPayment> {
    const response = await this.call(
      account,
      `/v1/payments/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    const parsed = paymentSchema.safeParse(await json(response));
    if (!parsed.success) {
      throw new PaymentProviderError('invalid_response');
    }
    const payment = parsed.data;
    return {
      status:
        payment.status === 'approved'
          ? 'approved'
          : payment.status === 'rejected' || payment.status === 'cancelled'
            ? 'rejected'
            : 'pending',
      amountArs: payment.transaction_amount,
      currency: payment.currency_id ?? null,
      reference: payment.external_reference ?? null,
      approvedAt: payment.date_approved
        ? new Date(payment.date_approved)
        : null,
    };
  }

  private async call(
    account: ProviderAccount,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = account.credentials?.accessToken;
    if (!token) {
      throw new PaymentProviderError('missing_credentials');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${MERCADOPAGO_API}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PaymentProviderError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'network_error',
      );
    }
    if (!response.ok) {
      throw new PaymentProviderError(`http_${response.status}`);
    }
    return response;
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PaymentProviderError('invalid_response');
  }
}

function header(
  headers: NotificationRequest['headers'],
  name: string,
): string | undefined {
  return text(headers[name]);
}

/** A trimmed non-empty string from a header or query value. */
function text(value: unknown): string | undefined {
  const raw: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined;
  }
  const trimmed = String(raw).trim();
  return trimmed || undefined;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
