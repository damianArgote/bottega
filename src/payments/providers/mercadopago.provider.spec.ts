import { createHmac } from 'node:crypto';
import {
  MERCADOPAGO_API,
  MercadoPagoProvider,
} from './mercadopago.provider.js';
import {
  PaymentProviderError,
  type NotificationRequest,
  type ProviderAccount,
} from './payment-provider.js';
import { TransferProvider } from './transfer.provider.js';

const TOKEN = 'APP_USR-token-del-negocio';
const SECRET = 'your_secret_key_here';
const REQUEST_ID = '2066ca19-c6f1-498a-be75-1923005edd06';
const TS = '1742505638683';
const account: ProviderAccount = {
  id: 'acc-1',
  credentials: { accessToken: TOKEN, webhookSecret: SECRET },
};

/** The SDK's own computation (mercadopago/sdk-nodejs webhook.spec.ts). */
function sign(dataId: string | undefined, requestId: string | undefined) {
  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${TS}`);
  const hash = createHmac('sha256', SECRET)
    .update(parts.join(';') + ';')
    .digest('hex');
  return `ts=${TS},v1=${hash}`;
}

const notification = (
  overrides: Partial<NotificationRequest> = {},
): NotificationRequest => ({
  headers: {
    'x-signature': sign('123456', REQUEST_ID),
    'x-request-id': REQUEST_ID,
  },
  query: { 'data.id': '123456', type: 'payment' },
  body: { type: 'payment', action: 'payment.updated', data: { id: '123456' } },
  ...overrides,
});

describe('MercadoPagoProvider', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const provider = new MercadoPagoProvider(fetchMock);

  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe('createLink', () => {
    const request = {
      id: 'pay-1',
      concept: 'Seña turno jueves',
      amountArs: 5000,
      expiresAt: new Date('2026-11-07T15:00:00.000Z'),
      notificationUrl:
        'https://api.example.com/webhooks/payments/mercadopago/key',
    };

    it('creates a preference with the business token, our reference and the expiry', async () => {
      fetchMock.mockResolvedValue(
        Response.json({
          id: 'pref-9',
          init_point:
            'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-9',
        }),
      );

      const link = await provider.createLink(account, request);

      expect(link).toEqual({
        url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-9',
        providerRef: 'pref-9',
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${MERCADOPAGO_API}/checkout/preferences`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        'X-Idempotency-Key': 'pay-1',
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        items: [
          {
            id: 'pay-1',
            title: 'Seña turno jueves',
            quantity: 1,
            unit_price: 5000,
            currency_id: 'ARS',
          },
        ],
        external_reference: 'pay-1',
        notification_url: request.notificationUrl,
        expires: true,
        expiration_date_to: '2026-11-07T15:00:00.000Z',
        date_of_expiration: '2026-11-07T15:00:00.000Z',
      });
    });

    it('fails with a content-free code, never the token', async () => {
      fetchMock.mockResolvedValue(
        new Response('{"message":"bad"}', { status: 401 }),
      );

      const error = await provider
        .createLink(account, request)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).code).toBe('http_401');
      expect(String(error)).not.toContain(TOKEN);
    });

    it('fails on an answer without a link', async () => {
      fetchMock.mockResolvedValue(Response.json({ id: 'pref-9' }));
      await expect(provider.createLink(account, request)).rejects.toMatchObject(
        {
          code: 'invalid_response',
        },
      );
    });
  });

  describe('verifyNotification', () => {
    it('returns the payment id of a correctly signed payment notification', () => {
      expect(provider.verifyNotification(account, notification())).toBe(
        '123456',
      );
    });

    it('rejects another secret, a changed id and a missing signature', () => {
      const other: ProviderAccount = {
        id: 'acc-1',
        credentials: { accessToken: TOKEN, webhookSecret: 'otra-clave' },
      };
      expect(provider.verifyNotification(other, notification())).toBeNull();
      expect(
        provider.verifyNotification(
          account,
          notification({ query: { 'data.id': '999999', type: 'payment' } }),
        ),
      ).toBeNull();
      expect(
        provider.verifyNotification(
          account,
          notification({ headers: { 'x-request-id': REQUEST_ID } }),
        ),
      ).toBeNull();
      expect(
        provider.verifyNotification(
          account,
          notification({
            headers: { 'x-signature': 'garbage', 'x-request-id': REQUEST_ID },
          }),
        ),
      ).toBeNull();
    });

    it('signs without the pairs that are missing, as the SDK does', () => {
      expect(
        provider.verifyNotification(
          account,
          notification({
            headers: { 'x-signature': sign('123456', undefined) },
          }),
        ),
      ).toBe('123456');
    });

    it('ignores a signed notification that is not about a payment', () => {
      expect(
        provider.verifyNotification(
          account,
          notification({
            query: { 'data.id': '123456', type: 'merchant_order' },
            body: { type: 'merchant_order' },
          }),
        ),
      ).toBeNull();
    });
  });

  describe('fetchPayment', () => {
    it('reads the status, amount, reference and approval date', async () => {
      fetchMock.mockResolvedValue(
        Response.json({
          id: 123456,
          status: 'approved',
          transaction_amount: 5000,
          currency_id: 'ARS',
          external_reference: 'pay-1',
          date_approved: '2026-11-06T12:00:00.000-03:00',
        }),
      );

      await expect(provider.fetchPayment(account, '123456')).resolves.toEqual({
        status: 'approved',
        amountArs: 5000,
        currency: 'ARS',
        reference: 'pay-1',
        approvedAt: new Date('2026-11-06T15:00:00.000Z'),
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${MERCADOPAGO_API}/v1/payments/123456`);
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });

    it('maps rejected and cancelled to rejected, anything else to pending', async () => {
      for (const [status, expected] of [
        ['rejected', 'rejected'],
        ['cancelled', 'rejected'],
        ['in_process', 'pending'],
        ['refunded', 'pending'],
      ]) {
        fetchMock.mockResolvedValueOnce(
          Response.json({ status, transaction_amount: 10 }),
        );
        await expect(
          provider.fetchPayment(account, '1'),
        ).resolves.toMatchObject({ status: expected });
      }
    });

    it('fails when the lookup fails', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 404 }));
      await expect(provider.fetchPayment(account, '1')).rejects.toMatchObject({
        code: 'http_404',
      });
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expect(provider.fetchPayment(account, '1')).rejects.toMatchObject({
        code: 'network_error',
      });
    });
  });
});

describe('TransferProvider', () => {
  const provider = new TransferProvider();

  it('has no link, never verifies a notification and never looks a payment up', async () => {
    await expect(provider.createLink()).resolves.toEqual({
      url: null,
      providerRef: null,
    });
    expect(provider.verifyNotification()).toBeNull();
    await expect(provider.fetchPayment()).rejects.toMatchObject({
      code: 'not_supported',
    });
  });
});
