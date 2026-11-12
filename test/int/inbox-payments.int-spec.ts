import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import {
  InMemoryLoginRateLimiter,
  LOGIN_RATE_LIMITER,
} from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { PaymentAccountsService } from '../../src/payments/payment-accounts.service.js';
import { PaymentsService } from '../../src/payments/payments.service.js';
import { PAYMENT_FETCH } from '../../src/payments/providers/mercadopago.provider.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  WHATSAPP_CLIENT_FACTORY,
  type SendOutcome,
} from '../../src/whatsapp/whatsapp.client.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';
import { createLine, resetDb, textEvent } from './helpers.js';

const PASSWORD = 'una clave larga';
const USER = '5491100001234';
const HOUR = 60 * 60 * 1000;
const CLIENT_ID = '6f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const LINK =
  'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1';

describe('Inbox payments (integration, HTTP)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const paymentFetch = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
  let businessId: string;
  let ip = 0;

  beforeAll(async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.bottega.example';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: (keys: string[]) => limiter.attempt(keys) })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(
        fixedClientFactory({ sendText, markRead: () => Promise.resolve(true) }),
      )
      .overrideProvider(PAYMENT_FETCH)
      .useValue(paymentFetch)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    delete process.env.PUBLIC_BASE_URL;
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
    sendText.mockReset();
    sendText.mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out.1' });
    paymentFetch.mockReset();
    paymentFetch.mockResolvedValue(
      Response.json({ id: 'pref-1', init_point: LINK }),
    );
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    for (const [email, name] of [
      ['ana@example.com', 'Ana'],
      ['beto@example.com', 'Beto'],
    ]) {
      await app.get(UsersService).addToBusiness(businessId, {
        email: email!,
        name: name!,
        password: PASSWORD,
        role: 'AGENT',
      });
    }
    await prisma.webhookSubscription.create({
      data: {
        businessId,
        url: 'https://n8n.example.com/hook',
        secretEncrypted: app.get(LineCredentialsService).encrypt('whsec_x'),
        events: ['payment.approved'],
      },
    });
  });

  const http = () => request(app.getHttpServer());
  const sessionOf = async (email: string) => {
    ip += 1;
    const res = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', `10.3.0.${ip}`)
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };
  const conversationId = async () => {
    await app.get(ConversationsService).recordInbound({
      ...textEvent('wamid.in.1', USER, 'hola'),
      timestamp: new Date(),
    });
    return (await prisma.conversation.findFirstOrThrow()).id;
  };
  const account = (
    provider: 'mercadopago' | 'transfer',
    business = businessId,
  ) =>
    app.get(PaymentAccountsService).create(
      business,
      provider === 'mercadopago'
        ? {
            provider,
            label: 'Mercado Pago',
            accessToken: 'APP_USR-token',
            webhookSecret: 'mp-webhook-secret',
            active: true,
          }
        : {
            provider,
            label: 'Transferencia',
            alias: 'botsuite.pagos',
            holder: 'BotSuite46 SRL',
            active: true,
          },
    );
  const charge = (cookie: string, id: string, body: object = {}) =>
    http()
      .post(`/inbox/businesses/${businessId}/conversations/${id}/payments`)
      .set('Cookie', cookie)
      .send({
        amountArs: 15000,
        concept: 'Seña',
        clientId: CLIENT_ID,
        ...body,
      });
  const markPaid = (cookie: string, paymentId: string, business = businessId) =>
    http()
      .post(`/inbox/businesses/${business}/payments/${paymentId}/mark-paid`)
      .set('Cookie', cookie);

  it('sends a Mercado Pago link as the person reply and takes the conversation', async () => {
    await account('mercadopago');
    const id = await conversationId();
    const ana = await sessionOf('ana@example.com');

    const res = await charge(ana, id).expect(200);

    expect(res.body).toMatchObject({
      payment: {
        status: 'PENDING',
        amountArs: 15000,
        concept: 'Seña',
        purpose: 'manual',
        linkUrl: LINK,
      },
      message: { outcome: 'sent' },
    });
    expect(sendText).toHaveBeenCalledWith(
      USER,
      `Te paso el link para pagar Seña ($15.000): ${LINK}`,
    );
    const conversation = await prisma.conversation.findFirstOrThrow({
      include: { assignedTo: true },
    });
    expect(conversation.assignedTo?.name).toBe('Ana');
  });

  it('the same clientId never charges nor sends twice', async () => {
    await account('mercadopago');
    const id = await conversationId();
    const ana = await sessionOf('ana@example.com');

    await charge(ana, id).expect(200);
    const again = await charge(ana, id).expect(200);

    expect(again.body).toMatchObject({ message: { outcome: 'replayed' } });
    expect(await prisma.payment.count()).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(paymentFetch).toHaveBeenCalledTimes(1);
  });

  it('with the window closed or someone else on it, nothing is created nor sent', async () => {
    await account('mercadopago');
    const id = await conversationId();
    const ana = await sessionOf('ana@example.com');
    const beto = await sessionOf('beto@example.com');
    await http()
      .post(`/inbox/businesses/${businessId}/conversations/${id}/take`)
      .set('Cookie', beto)
      .send({})
      .expect(200);

    const taken = await charge(ana, id).expect(409);
    expect(taken.body).toMatchObject({ code: 'ALREADY_TAKEN' });

    await prisma.conversation.update({
      where: { id },
      data: {
        lastInboundAt: new Date(Date.now() - 25 * HOUR),
        windowExpiresAt: new Date(Date.now() - HOUR),
      },
    });
    const closed = await charge(beto, id).expect(409);
    expect(closed.body).toMatchObject({ code: 'WINDOW_CLOSED' });

    expect(await prisma.payment.count()).toBe(0);
    expect(paymentFetch).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('without a payment account it is 409 NO_PAYMENT_ACCOUNT', async () => {
    const id = await conversationId();
    const ana = await sessionOf('ana@example.com');
    const res = await charge(ana, id).expect(409);
    expect(res.body).toMatchObject({ code: 'NO_PAYMENT_ACCOUNT' });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a transfer stays pending until a person marks it paid, once', async () => {
    await account('transfer');
    const id = await conversationId();
    const ana = await sessionOf('ana@example.com');

    const res = await charge(ana, id).expect(200);
    const paymentId = (res.body as { payment: { id: string } }).payment.id;
    expect(sendText).toHaveBeenCalledWith(
      USER,
      [
        'Para pagar Seña ($15.000), transferí a:',
        'Alias/CBU: botsuite.pagos',
        'Titular: BotSuite46 SRL',
        'Después mandanos el comprobante por acá.',
      ].join('\n'),
    );
    const list = await http()
      .get(`/inbox/businesses/${businessId}/conversations/${id}/payments`)
      .set('Cookie', ana)
      .expect(200);
    expect(list.body).toMatchObject([{ id: paymentId, status: 'PENDING' }]);

    const marked = await markPaid(ana, paymentId).expect(200);
    await markPaid(ana, paymentId).expect(200);

    const user = await prisma.user.findFirstOrThrow({
      where: { email: 'ana@example.com' },
    });
    expect(marked.body).toMatchObject({
      status: 'APPROVED',
      approvedBy: 'USER',
      approvedByUserId: user.id,
    });
    expect(
      await prisma.webhookDelivery.count({
        where: { event: 'payment.approved' },
      }),
    ).toBe(1);
  });

  it("another business's payment and conversation are 404; another business's route is 403", async () => {
    const other = await createLine(prisma, {
      slug: 'otro',
      phoneNumberId: '999000',
    });
    await account('transfer', other.businessId);
    await app.get(ConversationsService).recordInbound(
      {
        ...textEvent('wamid.other.1', USER, 'hola'),
        phoneNumberId: '999000',
        timestamp: new Date(),
      },
      { lineId: other.lineId, businessId: other.businessId },
    );
    const otherConversation = await prisma.conversation.findFirstOrThrow({
      where: { line: { businessId: other.businessId } },
    });
    const { payment } = await app.get(PaymentsService).create({
      conversationId: otherConversation.id,
      amountArs: 100,
      concept: 'Otro',
      purpose: 'manual',
      requestedBy: 'person',
    });
    const ana = await sessionOf('ana@example.com');

    await markPaid(ana, payment.id).expect(404);
    await markPaid(ana, payment.id, other.businessId).expect(403);
    await http()
      .get(
        `/inbox/businesses/${businessId}/conversations/${otherConversation.id}/payments`,
      )
      .set('Cookie', ana)
      .expect(404);
    await charge(ana, otherConversation.id).expect(404);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe('PENDING');
  });
});
