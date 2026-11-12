import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PaymentAccountsService } from '../../src/payments/payment-accounts.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const TOKEN = 'APP_USR-1234567890-token-secreto';
const WEBHOOK_SECRET = 'mp-webhook-secret-abcdef';

const mercadoPago = {
  provider: 'mercadopago',
  label: 'Mercado Pago',
  accessToken: TOKEN,
  webhookSecret: WEBHOOK_SECRET,
};
const transfer = {
  provider: 'transfer',
  label: 'Transferencia',
  alias: 'botsuite.pagos',
  holder: 'BotSuite46 SRL',
};

interface AccountBody {
  id: string;
  isDefault: boolean;
  webhookPath: string | null;
}

describe('Payment accounts: setup routes (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let businessId: string;
  let otherBusinessId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    otherBusinessId = (
      await createLine(prisma, { slug: 'otro', phoneNumberId: '999000' })
    ).businessId;
  });

  const http = () => request(app.getHttpServer());
  const admin = (path = '', business = businessId) =>
    `/admin/businesses/${business}/payment-accounts${path}`;
  const create = async (body: object, business = businessId) =>
    (
      await http()
        .post(admin('', business))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send(body)
        .expect(201)
    ).body as AccountBody;

  it('stores Mercado Pago credentials encrypted and never returns them', async () => {
    const created = await create(mercadoPago);

    expect(created).toMatchObject({
      provider: 'mercadopago',
      label: 'Mercado Pago',
      isDefault: true,
      active: true,
      transfer: null,
    });
    expect(created.webhookPath).toMatch(
      /^\/webhooks\/payments\/mercadopago\/[\w-]{20,}$/,
    );
    const stored = await prisma.paymentAccount.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.credentialsEncrypted).not.toContain(TOKEN);
    expect(stored.credentialsEncrypted).not.toContain(WEBHOOK_SECRET);
    const list = await http()
      .get(admin())
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);
    expect(list.body).toHaveLength(1);
    const listed = JSON.stringify(list.body);
    for (const secret of [TOKEN, WEBHOOK_SECRET, 'credentials']) {
      expect(listed).not.toContain(secret);
    }
  });

  it('keeps one default account per business', async () => {
    const first = await create(mercadoPago);
    const second = await create(transfer);
    expect(second).toMatchObject({
      isDefault: false,
      transfer: { alias: 'botsuite.pagos', holder: 'BotSuite46 SRL' },
      webhookPath: null,
    });

    await http()
      .patch(admin(`/${second.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ isDefault: true })
      .expect(200);

    const accounts = await prisma.paymentAccount.findMany({
      where: { businessId },
    });
    expect(
      accounts.filter((a) => a.isDefault).map((account) => account.id),
    ).toEqual([second.id]);
    expect(accounts.find((a) => a.id === first.id)?.isDefault).toBe(false);

    // Deactivating the default leaves no default.
    const off = await http()
      .patch(admin(`/${second.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ active: false })
      .expect(200);
    expect(off.body).toMatchObject({ active: false, isDefault: false });
  });

  it('rotates one Mercado Pago credential and keeps the other', async () => {
    const created = await create(mercadoPago);
    await http()
      .patch(admin(`/${created.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ webhookSecret: 'otro-secreto-de-webhook' })
      .expect(200);

    const stored = await prisma.paymentAccount.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(
      app.get(PaymentAccountsService).mercadoPagoCredentials(stored),
    ).toEqual({ accessToken: TOKEN, webhookSecret: 'otro-secreto-de-webhook' });
  });

  it('rejects fields of the other provider and invalid bodies', async () => {
    const created = await create(transfer);
    const res = await http()
      .patch(admin(`/${created.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ accessToken: TOKEN })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'WRONG_PROVIDER_FIELDS' });
    await http()
      .post(admin())
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ provider: 'modo', label: 'MODO' })
      .expect(400);
    await http()
      .post(admin())
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ ...transfer, accessToken: TOKEN })
      .expect(400);
  });

  it("never reaches another business's account", async () => {
    const created = await create(transfer);
    await http()
      .patch(admin(`/${created.id}`, otherBusinessId))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ label: 'Robada' })
      .expect(404);
    await http()
      .delete(admin(`/${created.id}`, otherBusinessId))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(404);
    await http()
      .delete(admin(`/${created.id}`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(204);
  });

  it('staff manage accounts; an owner cannot', async () => {
    const users = app.get(UsersService);
    const { user } = await users.addToBusiness(businessId, {
      email: 'olga@example.com',
      name: 'Olga',
      password: PASSWORD,
      role: 'OWNER',
    });
    const login = async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email: 'olga@example.com', password: PASSWORD })
        .expect(200);
      return (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('bottega_session='))!
        .split(';')[0]!;
    };
    const staffPath = `/staff/businesses/${businessId}/payment-accounts`;

    await http().get(admin()).expect(401);
    const owner = await login();
    await http().get(staffPath).set('Cookie', owner).expect(403);

    await http()
      .put(`/admin/users/${user.id}/staff`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ staff: true })
      .expect(200);
    const staff = await login();
    await http()
      .post(staffPath)
      .set('Cookie', staff)
      .send(transfer)
      .expect(201);
    const list = await http().get(staffPath).set('Cookie', staff).expect(200);
    expect(list.body).toMatchObject([{ provider: 'transfer' }]);
  });
});
