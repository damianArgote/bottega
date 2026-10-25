import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { GraphWhatsAppClient } from '../../src/whatsapp/graph-whatsapp.client.js';
import { resetDb, testConfig } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const BASE_URL = 'https://bottega.example.com';

const lineBody = {
  phoneNumberId: '700000000000001',
  wabaId: '800000000000001',
  appId: '900000000000001',
  appSecret: 'client-app-secret-value',
  accessToken: 'EAAG-client-system-user-token-value',
  displayPhone: '+54 9 11 5555-0001',
};

describe('Admin: businesses and lines (integration)', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let credentials: LineCredentialsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue(testConfig({ PUBLIC_BASE_URL: BASE_URL }))
      .overrideProvider(GraphWhatsAppClient)
      .useValue(
        new GraphWhatsAppClient(
          { apiVersion: 'v26.0', timeoutMs: 1_000 },
          fetchMock,
        ),
      )
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    credentials = app.get(LineCredentialsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      ),
    );
  });

  const adminPost = (path: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/admin${path}`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send(body as object);

  const createBusiness = async (slug = 'peluqueria-ana') => {
    const res = await adminPost('/businesses', {
      name: 'Peluquería Ana',
      slug,
      botName: 'Ana, IA de Peluquería Ana',
    }).expect(201);
    return res.body as { id: string };
  };

  it('creates a business', async () => {
    const res = await adminPost('/businesses', {
      name: 'Peluquería Ana',
      slug: 'peluqueria-ana',
      botName: 'Ana, IA de Peluquería Ana',
    }).expect(201);

    expect(res.body).toMatchObject({
      id: expect.any(String) as unknown,
      name: 'Peluquería Ana',
      slug: 'peluqueria-ana',
      botName: 'Ana, IA de Peluquería Ana',
    });
    expect(
      await prisma.business.count({ where: { slug: 'peluqueria-ana' } }),
    ).toBe(1);
  });

  it('answers 409 to a repeated slug', async () => {
    await createBusiness();

    await adminPost('/businesses', {
      name: 'Otra',
      slug: 'peluqueria-ana',
      botName: 'Otra',
    }).expect(409);
  });

  it('creates a line with encrypted credentials, returns its webhook and subscribes the app', async () => {
    const business = await createBusiness();

    const res = await adminPost(
      `/businesses/${business.id}/lines`,
      lineBody,
    ).expect(201);

    const line = await prisma.line.findUniqueOrThrow({
      where: { phoneNumberId: lineBody.phoneNumberId },
    });
    expect(res.body).toEqual({
      line: {
        id: line.id,
        businessId: business.id,
        phoneNumberId: lineBody.phoneNumberId,
        wabaId: lineBody.wabaId,
        appId: lineBody.appId,
        displayPhone: lineBody.displayPhone,
        active: true,
        createdAt: line.createdAt.toISOString(),
      },
      webhookUrl: `${BASE_URL}/webhooks/whatsapp/${line.webhookKey}`,
      webhookPath: `/webhooks/whatsapp/${line.webhookKey}`,
      verifyToken: line.verifyToken,
      subscription: { subscribed: true },
    });
    expect(line.webhookKey).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(lineBody.appSecret);
    expect(raw).not.toContain(lineBody.accessToken);
    expect(credentials.decrypt(line.appSecretEncrypted!)).toBe(
      lineBody.appSecret,
    );
    expect(credentials.decrypt(line.accessTokenEncrypted!)).toBe(
      lineBody.accessToken,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://graph.facebook.com/v26.0/${lineBody.wabaId}/subscribed_apps`,
    );
    expect(init).toMatchObject({
      headers: { Authorization: `Bearer ${lineBody.accessToken}` },
    });
  });

  it('still creates the line when the subscription fails, and says so', async () => {
    const business = await createBusiness();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 200, message: 'Permissions error' },
          }),
          { status: 403 },
        ),
      ),
    );

    const res = await adminPost(
      `/businesses/${business.id}/lines`,
      lineBody,
    ).expect(201);

    expect((res.body as { subscription: unknown }).subscription).toEqual({
      subscribed: false,
      code: 200,
      message: 'Permissions error',
    });
    expect(await prisma.line.count()).toBe(2);
  });

  it('answers 404 for an unknown business', async () => {
    await adminPost(
      '/businesses/00000000-0000-4000-8000-000000000000/lines',
      lineBody,
    ).expect(404);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 409 to a phone number id that already has a line', async () => {
    const business = await createBusiness();
    await adminPost(`/businesses/${business.id}/lines`, lineBody).expect(201);
    fetchMock.mockClear();

    await adminPost(`/businesses/${business.id}/lines`, lineBody).expect(409);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the new line receives webhooks signed with its own app secret', async () => {
    const business = await createBusiness();
    const res = await adminPost(
      `/businesses/${business.id}/lines`,
      lineBody,
    ).expect(201);
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: lineBody.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '5491155550001',
                  phone_number_id: lineBody.phoneNumberId,
                },
                messages: [
                  {
                    from: '5491100001234',
                    id: 'wamid.client.1',
                    timestamp: '1760140800',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', lineBody.appSecret).update(raw).digest('hex')}`;

    await request(app.getHttpServer())
      .post((res.body as { webhookPath: string }).webhookPath)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(raw)
      .expect(200);

    const contact = await prisma.contact.findFirstOrThrow({
      where: { waId: '5491100001234' },
    });
    expect(contact.businessId).toBe(business.id);
  });
});
