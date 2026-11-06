import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { PaymentAccountsService } from '../../src/payments/payment-accounts.service.js';
import { PaymentExpiryScheduler } from '../../src/payments/payment-expiry.scheduler.js';
import { PaymentsService } from '../../src/payments/payments.service.js';
import { PAYMENT_FETCH } from '../../src/payments/providers/mercadopago.provider.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb, textEvent } from './helpers.js';

const BASE_URL = 'https://api.bottega.example';
const SECRET = 'mp-webhook-secret-abcdef';
const USER = '5491100001234';
const MP_PAYMENT = '1319900001';

interface Remote {
  status: string;
  amount: number;
  reference: string;
  approved?: string | null;
}

describe('Payments: charges and Mercado Pago notifications (integration)', () => {
  const paymentFetch = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let businessId: string;
  let conversationId: string;
  let webhookKey: string;
  let remote: Remote | 'fail';
  let lookups: string[];
  let preferences: number;

  beforeAll(async () => {
    process.env.PUBLIC_BASE_URL = BASE_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_FETCH)
      .useValue(paymentFetch)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
  });

  afterAll(async () => {
    delete process.env.PUBLIC_BASE_URL;
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    paymentFetch.mockReset();
    lookups = [];
    preferences = 0;
    remote = 'fail';
    paymentFetch.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/checkout/preferences')) {
        preferences += 1;
        return Promise.resolve(
          Response.json({
            id: `pref-${preferences}`,
            init_point: `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-${preferences}`,
          }),
        );
      }
      const id = url.split('/v1/payments/')[1] ?? '';
      lookups.push(id);
      if (remote === 'fail') {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      return Promise.resolve(
        Response.json({
          id: Number(id),
          status: remote.status,
          transaction_amount: remote.amount,
          currency_id: 'ARS',
          external_reference: remote.reference,
          date_approved: remote.approved ?? null,
        }),
      );
    });
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    const account = await app.get(PaymentAccountsService).create(businessId, {
      provider: 'mercadopago',
      label: 'Mercado Pago',
      accessToken: 'APP_USR-token',
      webhookSecret: SECRET,
      active: true,
    });
    webhookKey = account.webhookPath!.split('/').pop()!;
    const inbound = await app
      .get(ConversationsService)
      .recordInbound(textEvent('wamid.pay.1', USER, 'quiero pagar'));
    if (inbound.outcome !== 'created') {
      throw new Error(`inbound not recorded: ${inbound.outcome}`);
    }
    conversationId = inbound.conversationId;
    await prisma.webhookSubscription.create({
      data: {
        businessId,
        url: 'https://n8n.example.com/hook',
        secretEncrypted: app.get(LineCredentialsService).encrypt('whsec_x'),
        events: ['payment.approved', 'payment.review', 'payment.expired'],
      },
    });
  });

  const http = () => request(app.getHttpServer());
  const charge = (amountArs = 5000, idempotencyKey: string | null = null) =>
    payments.create({
      conversationId,
      amountArs,
      concept: 'Seña turno jueves',
      purpose: 'manual',
      idempotencyKey,
      requestedBy: 'person',
    });
  const notify = (
    paymentId = MP_PAYMENT,
    secret = SECRET,
    key = webhookKey,
  ) => {
    const ts = '1762430000';
    const requestId = `req-${paymentId}`;
    const hash = createHmac('sha256', secret)
      .update(`id:${paymentId};request-id:${requestId};ts:${ts};`)
      .digest('hex');
    return http()
      .post(
        `/webhooks/payments/mercadopago/${key}?data.id=${paymentId}&type=payment`,
      )
      .set('x-signature', `ts=${ts},v1=${hash}`)
      .set('x-request-id', requestId)
      .send({
        type: 'payment',
        action: 'payment.updated',
        data: { id: paymentId },
      });
  };
  const stored = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });
  const deliveries = (event: string) =>
    prisma.webhookDelivery.count({ where: { event } });

  it('creates the link with our reference and sends its fixed text', async () => {
    const { payment, text } = await charge();

    expect(payment).toMatchObject({
      status: 'PENDING',
      amountArs: 5000,
      purpose: 'manual',
      providerRef: 'pref-1',
    });
    expect(text).toBe(
      `Te paso el link para pagar Seña turno jueves ($5.000): ${payment.linkUrl}`,
    );
    const body = JSON.parse(paymentFetch.mock.calls[0]![1]!.body as string) as {
      external_reference: string;
      notification_url: string;
    };
    expect(body.external_reference).toBe(payment.id);
    expect(body.notification_url).toBe(
      `${BASE_URL}/webhooks/payments/mercadopago/${webhookKey}`,
    );
    const ttl = payment.expiresAt.getTime() - payment.createdAt.getTime();
    expect(Math.round(ttl / 60_000)).toBe(1440);
  });

  it('a repeated request with the same key makes one payment and one link', async () => {
    const first = await charge(5000, 'inbox:abc');
    const second = await charge(5000, 'inbox:abc');
    expect(second.payment.id).toBe(first.payment.id);
    expect(preferences).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('an approved payment confirms once even when notified three times', async () => {
    const { payment } = await charge();
    remote = { status: 'approved', amount: 5000, reference: payment.id };

    for (let i = 0; i < 3; i += 1) {
      await notify().expect(200);
    }

    expect(await stored(payment.id)).toMatchObject({
      status: 'APPROVED',
      approvedBy: 'PROVIDER',
      providerPaymentId: MP_PAYMENT,
    });
    expect(lookups).toEqual([MP_PAYMENT, MP_PAYMENT, MP_PAYMENT]);
    expect(await deliveries('payment.approved')).toBe(1);
    // A repeat is not a second payment: nobody is called in.
    expect(await prisma.handoffRequest.count()).toBe(0);
    expect(
      await prisma.webhookEvent.count({ where: { source: 'mercadopago' } }),
    ).toBe(3);
  });

  it('concurrent notifications of the same payment confirm once', async () => {
    const { payment } = await charge();
    remote = { status: 'approved', amount: 5000, reference: payment.id };

    await Promise.all([notify(), notify(), notify()]);

    expect((await stored(payment.id)).status).toBe('APPROVED');
    expect(await deliveries('payment.approved')).toBe(1);
  });

  it('another amount never confirms', async () => {
    const { payment } = await charge();
    remote = { status: 'approved', amount: 50, reference: payment.id };

    await notify().expect(200);

    expect((await stored(payment.id)).status).toBe('PENDING');
    expect(await deliveries('payment.approved')).toBe(0);
  });

  it('a bad signature does nothing: no record, no lookup, no change', async () => {
    const { payment } = await charge();
    remote = { status: 'approved', amount: 5000, reference: payment.id };

    await notify(MP_PAYMENT, 'otra-clave').expect(200);

    expect(lookups).toEqual([]);
    expect((await stored(payment.id)).status).toBe('PENDING');
    expect(
      await prisma.webhookEvent.count({ where: { source: 'mercadopago' } }),
    ).toBe(0);
  });

  it('a payment of another account is never confirmed through this key', async () => {
    const other = await createLine(prisma, {
      slug: 'otro',
      phoneNumberId: '999000',
    });
    const otherAccount = await app
      .get(PaymentAccountsService)
      .create(other.businessId, {
        provider: 'mercadopago',
        label: 'MP',
        accessToken: 'APP_USR-otro',
        webhookSecret: SECRET,
        active: true,
      });
    const { payment } = await charge();
    remote = { status: 'approved', amount: 5000, reference: payment.id };

    await notify(
      MP_PAYMENT,
      SECRET,
      otherAccount.webhookPath!.split('/').pop(),
    ).expect(200);

    expect((await stored(payment.id)).status).toBe('PENDING');
  });

  it('a failed lookup answers 502 so Mercado Pago retries, and the retry confirms', async () => {
    const { payment } = await charge();

    await notify().expect(502);
    expect((await stored(payment.id)).status).toBe('PENDING');

    remote = { status: 'approved', amount: 5000, reference: payment.id };
    await notify().expect(200);
    expect((await stored(payment.id)).status).toBe('APPROVED');
  });

  it('an unknown key is 404', async () => {
    await notify(MP_PAYMENT, SECRET, 'no-existe').expect(404);
  });

  it('approved after it expired goes to review and to a person', async () => {
    const { payment } = await charge();
    await prisma.payment.update({
      where: { id: payment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    remote = {
      status: 'approved',
      amount: 5000,
      reference: payment.id,
      approved: new Date().toISOString(),
    };

    await notify().expect(200);

    expect(await stored(payment.id)).toMatchObject({
      status: 'REVIEW',
      providerPaymentId: MP_PAYMENT,
    });
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.paused).toBe(true);
    expect(
      await prisma.handoffRequest.count({
        where: { conversationId, status: 'OPEN', reason: 'payment' },
      }),
    ).toBe(1);
    expect(await deliveries('payment.review')).toBe(1);
    expect(await deliveries('payment.approved')).toBe(0);
  });

  it('approved before it expired confirms even when notified late', async () => {
    const { payment } = await charge();
    await prisma.payment.update({
      where: { id: payment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    remote = {
      status: 'approved',
      amount: 5000,
      reference: payment.id,
      approved: new Date(Date.now() - 120_000).toISOString(),
    };

    await notify().expect(200);

    expect((await stored(payment.id)).status).toBe('APPROVED');
  });

  it('a rejected attempt can still be followed by an approved one on the same link', async () => {
    const { payment } = await charge();
    remote = { status: 'rejected', amount: 5000, reference: payment.id };
    await notify('111').expect(200);
    expect((await stored(payment.id)).status).toBe('REJECTED');

    remote = { status: 'approved', amount: 5000, reference: payment.id };
    await notify('222').expect(200);
    expect(await stored(payment.id)).toMatchObject({
      status: 'APPROVED',
      providerPaymentId: '222',
    });
  });

  it('the provider payment of a charge a person already marked paid is recorded, not taken as paid twice', async () => {
    const { payment } = await charge();
    const user = await prisma.user.create({
      data: { email: 'ana@example.com', name: 'Ana', passwordHash: 'x' },
    });
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'APPROVED',
        approvedBy: 'USER',
        approvedByUserId: user.id,
        approvedAt: new Date(),
      },
    });
    remote = { status: 'approved', amount: 5000, reference: payment.id };

    await notify().expect(200);

    expect(await stored(payment.id)).toMatchObject({
      status: 'APPROVED',
      approvedBy: 'USER',
      providerPaymentId: MP_PAYMENT,
    });
    expect(await prisma.handoffRequest.count()).toBe(0);
    expect(await deliveries('payment.approved')).toBe(0);
  });

  it('a second approved payment of the same charge goes to a person and changes nothing', async () => {
    const { payment } = await charge();
    remote = { status: 'approved', amount: 5000, reference: payment.id };
    await notify('111').expect(200);
    await notify('222').expect(200);

    expect(await stored(payment.id)).toMatchObject({
      status: 'APPROVED',
      providerPaymentId: '111',
    });
    expect(
      await prisma.handoffRequest.count({
        where: { conversationId, status: 'OPEN' },
      }),
    ).toBe(1);
    expect(await deliveries('payment.approved')).toBe(1);
  });

  describe('expiry', () => {
    const expire = (id: string) =>
      prisma.payment.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

    it('expires a due pending payment once, with payment.expired', async () => {
      const due = (await charge()).payment;
      const later = (await charge(7000)).payment;
      const paid = (await charge(9000)).payment;
      await expire(due.id);
      await expire(paid.id);
      await prisma.payment.update({
        where: { id: paid.id },
        data: { status: 'APPROVED' },
      });
      const scheduler = app.get(PaymentExpiryScheduler);

      expect(await scheduler.runDue()).toBe(1);
      expect(await scheduler.runDue()).toBe(0);

      expect((await stored(due.id)).status).toBe('EXPIRED');
      expect((await stored(later.id)).status).toBe('PENDING');
      expect((await stored(paid.id)).status).toBe('APPROVED');
      expect(await deliveries('payment.expired')).toBe(1);
      const delay = await scheduler.nextDelay();
      expect(delay).toBeGreaterThan(23 * 60 * 60_000);
    });

    it('a payment already marked expired goes to review, even if paid in time (what it paid may be gone)', async () => {
      const { payment } = await charge();
      await expire(payment.id);
      await app.get(PaymentExpiryScheduler).runDue();
      remote = {
        status: 'approved',
        amount: 5000,
        reference: payment.id,
        approved: new Date(Date.now() - 120_000).toISOString(),
      };

      await notify().expect(200);

      expect((await stored(payment.id)).status).toBe('REVIEW');
      expect(await deliveries('payment.review')).toBe(1);
    });
  });

  it('without an active default account it is 409 NO_PAYMENT_ACCOUNT', async () => {
    await prisma.paymentAccount.updateMany({
      data: { active: false, isDefault: false },
    });
    await expect(charge()).rejects.toMatchObject({
      response: { code: 'NO_PAYMENT_ACCOUNT' },
    });
  });

  describe('transfer', () => {
    beforeEach(async () => {
      await app.get(PaymentAccountsService).create(businessId, {
        provider: 'transfer',
        label: 'Transferencia',
        alias: 'botsuite.pagos',
        holder: 'BotSuite46 SRL',
        isDefault: true,
        active: true,
      });
    });

    it('sends the account data and, asked by the bot, passes to a person; it never confirms by itself', async () => {
      const { payment, text } = await payments.create({
        conversationId,
        amountArs: 12000,
        concept: 'Seña',
        purpose: 'booking',
        requestedBy: 'bot',
      });

      expect(text).toBe(
        [
          'Para pagar Seña ($12.000), transferí a:',
          'Alias/CBU: botsuite.pagos',
          'Titular: BotSuite46 SRL',
          'Después mandanos el comprobante por acá.',
        ].join('\n'),
      );
      expect(payment).toMatchObject({ status: 'PENDING', linkUrl: null });
      expect(preferences).toBe(0);
      expect(
        await prisma.handoffRequest.count({
          where: { conversationId, status: 'OPEN', reason: 'payment' },
        }),
      ).toBe(1);

      // A receipt from the contact is just a message: still pending.
      await app
        .get(ConversationsService)
        .recordInbound(
          textEvent(
            'wamid.pay.2',
            USER,
            'Ya transferí, te mando el comprobante',
          ),
        );
      expect((await stored(payment.id)).status).toBe('PENDING');
      await http()
        .post(`/webhooks/payments/transfer/${webhookKey}`)
        .send({})
        .expect(404);
    });
  });

  it('notification records never reach the WhatsApp reprocessor', async () => {
    const { payment } = await charge();
    remote = { status: 'approved', amount: 5000, reference: payment.id };
    await notify().expect(200);
    expect(
      await prisma.webhookEvent.count({ where: { processedAt: null } }),
    ).toBe(0);
  });
});
