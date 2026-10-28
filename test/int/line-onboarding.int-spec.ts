import { createHmac } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { LOGIN_RATE_LIMITER } from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { GraphOnboardingClient } from '../../src/whatsapp/graph-onboarding.client.js';
import { GraphWhatsAppClient } from '../../src/whatsapp/graph-whatsapp.client.js';
import { createLine, resetDb, testConfig } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const BASE_URL = 'https://bottega.example.com';
const GRAPH = 'https://graph.facebook.com/v26.0';
const PASSWORD = 'una clave larga';
const PHONE_ID = '700000000000001';
const PIN = '482915';

const credentialsBody = {
  wabaId: '800000000000001',
  appId: '900000000000001',
  appSecret: 'client-app-secret-value',
  accessToken: 'EAAG-client-system-user-token-value',
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const metaError = (code: number, status = 400, subcode?: number) =>
  json(
    { error: { code, message: `meta error ${code}`, error_subcode: subcode } },
    status,
  );

/** Answers like Meta for the happy path; tests override single routes. */
function metaOk(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (url.startsWith(`${GRAPH}/${credentialsBody.wabaId}?`)) {
    return json({ id: credentialsBody.wabaId, name: 'Peluquería Ana' });
  }
  if (url.startsWith(`${GRAPH}/${credentialsBody.appId}?`)) {
    return json({ id: credentialsBody.appId });
  }
  if (url.startsWith(`${GRAPH}/${credentialsBody.wabaId}/phone_numbers?`)) {
    return json({
      data: [
        {
          id: PHONE_ID,
          display_phone_number: '+54 9 11 5555-0001',
          verified_name: 'Peluquería Ana',
          code_verification_status: 'VERIFIED',
          name_status: 'APPROVED',
          quality_rating: 'GREEN',
        },
      ],
    });
  }
  if (url.startsWith(`${GRAPH}/${PHONE_ID}?`)) {
    return json({
      id: PHONE_ID,
      display_phone_number: '+54 9 11 5555-0001',
      verified_name: 'Peluquería Ana',
      code_verification_status: 'VERIFIED',
      name_status: 'APPROVED',
      quality_rating: 'GREEN',
    });
  }
  if (url === `${GRAPH}/${PHONE_ID}/register` && method === 'POST') {
    return json({ success: true });
  }
  if (url === `${GRAPH}/${credentialsBody.wabaId}/subscribed_apps`) {
    return method === 'POST'
      ? json({ success: true })
      : json({
          data: [
            {
              whatsapp_business_api_data: {
                id: credentialsBody.appId,
                name: 'Bottega Ana',
              },
            },
          ],
        });
  }
  throw new Error(`unexpected Meta call: ${method} ${url}`);
}

interface DraftResponse {
  line: { id: string };
  webhookUrl: string;
  webhookPath: string;
  verifyToken: string;
}

describe('Line onboarding (integration)', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let credentials: LineCredentialsService;
  let users: UsersService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue(testConfig({ PUBLIC_BASE_URL: BASE_URL }))
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: () => true })
      .overrideProvider(GraphWhatsAppClient)
      .useValue(
        new GraphWhatsAppClient(
          { apiVersion: 'v26.0', timeoutMs: 1_000 },
          fetchMock,
        ),
      )
      .overrideProvider(GraphOnboardingClient)
      .useValue(
        new GraphOnboardingClient(
          { apiVersion: 'v26.0', timeoutMs: 1_000 },
          fetchMock,
        ),
      )
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    credentials = app.get(LineCredentialsService);
    users = app.get(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    fetchMock.mockImplementation((input, init) =>
      metaOk(input as string, init),
    );
  });

  const http = () => request(app.getHttpServer());
  const adminPut = (path: string, body: unknown) =>
    http()
      .put(`/admin${path}`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send(body as object);

  const createDraft = async (slug = 'peluqueria-ana') => {
    const business = await createBusiness(slug);
    const draft = (
      await adminPost(`/businesses/${business.id}/lines`).expect(201)
    ).body as DraftResponse;
    return { businessId: business.id, lineId: draft.line.id };
  };

  const sessionOf = async (
    businessId: string,
    email: string,
    role: 'OWNER' | 'AGENT',
  ) => {
    await users.addToBusiness(businessId, {
      email,
      name: email.split('@')[0]!,
      password: PASSWORD,
      role,
    });
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return cookies
      .find((c) => c.startsWith('bottega_session='))!
      .split(';')[0]!;
  };

  const expectNoSecrets = (body: unknown) => {
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(credentialsBody.appSecret);
    expect(raw).not.toContain(credentialsBody.accessToken);
  };

  const adminPost = (path: string, body?: unknown) =>
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

  describe('draft line', () => {
    it('creates a draft with an empty body and returns its webhook', async () => {
      const business = await createBusiness();

      const res = await adminPost(`/businesses/${business.id}/lines`).expect(
        201,
      );

      const line = await prisma.line.findFirstOrThrow({
        where: { businessId: business.id },
      });
      expect(res.body).toEqual({
        line: {
          id: line.id,
          businessId: business.id,
          phoneNumberId: null,
          wabaId: null,
          appId: null,
          displayPhone: null,
          active: true,
          createdAt: line.createdAt.toISOString(),
        },
        webhookUrl: `${BASE_URL}/webhooks/whatsapp/${line.webhookKey}`,
        webhookPath: `/webhooks/whatsapp/${line.webhookKey}`,
        verifyToken: line.verifyToken,
      });
      expect(line.accessTokenEncrypted).toBeNull();
      expect(line.appSecretEncrypted).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('allows several drafts at once (no phone number id yet)', async () => {
      const business = await createBusiness();

      await adminPost(`/businesses/${business.id}/lines`, {}).expect(201);
      await adminPost(`/businesses/${business.id}/lines`, {}).expect(201);

      expect(
        await prisma.line.count({ where: { businessId: business.id } }),
      ).toBe(2);
    });

    it('rejects a partial body instead of creating half a line', async () => {
      const business = await createBusiness();

      await adminPost(`/businesses/${business.id}/lines`, {
        phoneNumberId: '700000000000001',
      }).expect(400);

      expect(
        await prisma.line.count({ where: { businessId: business.id } }),
      ).toBe(0);
    });

    it('answers the Meta verification handshake', async () => {
      const business = await createBusiness();
      const draft = (
        await adminPost(`/businesses/${business.id}/lines`).expect(201)
      ).body as DraftResponse;

      const res = await request(app.getHttpServer())
        .get(draft.webhookPath)
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': draft.verifyToken,
          'hub.challenge': 'OK-123',
        })
        .expect(200);

      expect(res.text).toBe('OK-123');
    });

    it('rejects every webhook delivery and stores nothing', async () => {
      const business = await createBusiness();
      const draft = (
        await adminPost(`/businesses/${business.id}/lines`).expect(201)
      ).body as DraftResponse;
      const raw = JSON.stringify({ object: 'whatsapp_business_account' });
      const signature = `sha256=${createHmac('sha256', 'any-secret').update(raw).digest('hex')}`;

      await request(app.getHttpServer())
        .post(draft.webhookPath)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(raw)
        .expect(401);

      expect(await prisma.webhookEvent.count()).toBe(0);
    });
  });

  describe('credentials', () => {
    it('checks them with Meta and stores them encrypted', async () => {
      const { lineId } = await createDraft();

      const res = await adminPut(
        `/lines/${lineId}/credentials`,
        credentialsBody,
      ).expect(200);

      expect(res.body).toMatchObject({
        line: {
          id: lineId,
          wabaId: credentialsBody.wabaId,
          appId: credentialsBody.appId,
          phoneNumberId: null,
        },
        wabaName: 'Peluquería Ana',
      });
      expectNoSecrets(res.body);
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      expect(credentials.decrypt(line.accessTokenEncrypted!)).toBe(
        credentialsBody.accessToken,
      );
      expect(credentials.decrypt(line.appSecretEncrypted!)).toBe(
        credentialsBody.appSecret,
      );
      const calls = fetchMock.mock.calls.map(([url, init]) => [
        url as string,
        (init?.headers as Record<string, string>)['Authorization'],
      ]);
      expect(calls).toEqual([
        [
          `${GRAPH}/${credentialsBody.wabaId}?fields=id,name`,
          `Bearer ${credentialsBody.accessToken}`,
        ],
        [
          `${GRAPH}/${credentialsBody.appId}?fields=id`,
          `Bearer ${credentialsBody.appId}|${credentialsBody.appSecret}`,
        ],
      ]);
    });

    it.each([
      [
        'a token Meta rejects',
        () => metaError(190, 401),
        400,
        'El token no es válido o venció',
        190,
      ],
      [
        'a token without permission on the account',
        () => metaError(200, 403),
        400,
        'El token no tiene permiso sobre esta cuenta',
        200,
      ],
      [
        'Meta unreachable',
        () => Promise.reject(new TypeError('fetch failed')),
        502,
        'No pudimos conectar con Meta',
        'network_error',
      ],
    ])(
      'answers %s with an explained error and stores nothing',
      async (_label, answer, status, text, metaCode) => {
        const { lineId } = await createDraft();
        fetchMock.mockImplementation(answer);

        const res = await adminPut(
          `/lines/${lineId}/credentials`,
          credentialsBody,
        ).expect(status);

        expect(res.body).toMatchObject({ metaCode });
        expect((res.body as { message: string }).message).toContain(text);
        expectNoSecrets(res.body);
        const line = await prisma.line.findUniqueOrThrow({
          where: { id: lineId },
        });
        expect(line.accessTokenEncrypted).toBeNull();
        expect(line.wabaId).toBeNull();
      },
    );

    it('rejects an app secret that does not belong to the app', async () => {
      const { lineId } = await createDraft();
      fetchMock.mockImplementation((input, init) =>
        (input as string).startsWith(`${GRAPH}/${credentialsBody.appId}?`)
          ? metaError(190, 400)
          : metaOk(input as string, init),
      );

      const res = await adminPut(
        `/lines/${lineId}/credentials`,
        credentialsBody,
      ).expect(400);

      expect((res.body as { message: string }).message).toContain(
        'El App ID o el App Secret no son válidos',
      );
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      expect(line.appSecretEncrypted).toBeNull();
    });

    it('answers 404 for an unknown line and 400 for a bad body', async () => {
      await adminPut(
        '/lines/00000000-0000-4000-8000-000000000000/credentials',
        credentialsBody,
      ).expect(404);
      const { lineId } = await createDraft();
      await adminPut(`/lines/${lineId}/credentials`, {
        ...credentialsBody,
        wabaId: 'abc',
      }).expect(400);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('on a line that already has a number, only accepts the account that holds it', async () => {
      // Like the seeded default line: a number, no WABA stored.
      const other = await createLine(prisma, {
        slug: 'otro',
        phoneNumberId: '700000000000999',
      });
      const same = await createLine(prisma, {
        slug: 'linea-env',
        phoneNumberId: PHONE_ID,
      });

      const res = await adminPut(
        `/lines/${other.lineId}/credentials`,
        credentialsBody,
      ).expect(400);
      expect((res.body as { message: string }).message).toContain(
        'no está en esa cuenta de WhatsApp',
      );
      const untouched = await prisma.line.findUniqueOrThrow({
        where: { id: other.lineId },
      });
      expect(untouched.accessTokenEncrypted).toBeNull();

      await adminPut(
        `/lines/${same.lineId}/credentials`,
        credentialsBody,
      ).expect(200);
    });

    it('lets an OWNER set them on a line of their business only', async () => {
      const a = await createDraft('lola');
      const b = await createDraft('kubbo');
      const cookie = await sessionOf(a.businessId, 'olga@example.com', 'OWNER');
      const put = (businessId: string, lineId: string) =>
        http()
          .put(
            `/inbox/businesses/${businessId}/settings/whatsapp/lines/${lineId}/credentials`,
          )
          .set('Cookie', cookie)
          .send(credentialsBody);

      const res = await put(a.businessId, a.lineId).expect(200);
      expectNoSecrets(res.body);
      await put(a.businessId, b.lineId).expect(404);
      await put(b.businessId, b.lineId).expect(403);

      const other = await prisma.line.findUniqueOrThrow({
        where: { id: b.lineId },
      });
      expect(other.accessTokenEncrypted).toBeNull();
    });

    it('an AGENT gets 403', async () => {
      const a = await createDraft('lola');
      const cookie = await sessionOf(a.businessId, 'ana@example.com', 'AGENT');

      await http()
        .put(
          `/inbox/businesses/${a.businessId}/settings/whatsapp/lines/${a.lineId}/credentials`,
        )
        .set('Cookie', cookie)
        .send(credentialsBody)
        .expect(403);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('number and app', () => {
    const withCredentials = async (slug = 'peluqueria-ana') => {
      const draft = await createDraft(slug);
      await adminPut(
        `/lines/${draft.lineId}/credentials`,
        credentialsBody,
      ).expect(200);
      fetchMock.mockClear();
      return draft;
    };

    it('asks for the credentials first', async () => {
      const { lineId } = await createDraft();

      await http()
        .get(`/admin/lines/${lineId}/phone-numbers`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(409);
      await adminPost(`/lines/${lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(409);
      await adminPost(`/lines/${lineId}/subscribe`).expect(409);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lists the numbers of the line's WhatsApp account", async () => {
      const { lineId } = await withCredentials();

      const res = await http()
        .get(`/admin/lines/${lineId}/phone-numbers`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);

      expect(res.body).toEqual({
        phoneNumbers: [
          {
            id: PHONE_ID,
            displayPhoneNumber: '+54 9 11 5555-0001',
            verifiedName: 'Peluquería Ana',
            codeVerificationStatus: 'VERIFIED',
            nameStatus: 'APPROVED',
            qualityRating: 'GREEN',
          },
        ],
      });
      expectNoSecrets(res.body);
    });

    it('registers the number with the PIN and never stores or echoes it', async () => {
      const logged: string[] = [];
      vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
        logged.push(String(m));
      });
      const { lineId } = await withCredentials();

      const res = await adminPost(`/lines/${lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(200);

      expect(res.body).toMatchObject({
        line: {
          id: lineId,
          phoneNumberId: PHONE_ID,
          displayPhone: '+54 9 11 5555-0001',
        },
      });
      const register = fetchMock.mock.calls.find(
        ([url]) => url === `${GRAPH}/${PHONE_ID}/register`,
      )!;
      expect(JSON.parse(register[1]!.body as string)).toEqual({
        messaging_product: 'whatsapp',
        pin: PIN,
      });
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      expect(JSON.stringify(line)).not.toContain(PIN);
      expect(JSON.stringify(res.body)).not.toContain(PIN);
      expect(logged.join('\n')).not.toContain(PIN);
      vi.restoreAllMocks();
    });

    it('rejects a number of another WhatsApp account without calling register', async () => {
      const { lineId } = await withCredentials();

      const res = await adminPost(`/lines/${lineId}/register`, {
        phoneNumberId: '700000000000999',
        pin: PIN,
      }).expect(400);

      expect((res.body as { message: string }).message).toContain(
        'no es de la cuenta de WhatsApp de esta línea',
      );
      expect(
        fetchMock.mock.calls.some(([url]) =>
          (url as string).endsWith('/register'),
        ),
      ).toBe(false);
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      expect(line.phoneNumberId).toBeNull();
    });

    it.each([
      ['a 5-digit PIN', { phoneNumberId: PHONE_ID, pin: '12345' }],
      ['a PIN with letters', { phoneNumberId: PHONE_ID, pin: '12a456' }],
      ['no PIN', { phoneNumberId: PHONE_ID }],
    ])('answers 400 to %s and echoes nothing', async (_label, body) => {
      const { lineId } = await withCredentials();

      const res = await adminPost(`/lines/${lineId}/register`, body).expect(
        400,
      );

      expect(JSON.stringify(res.body)).not.toContain('12345');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('explains a PIN Meta rejects and keeps the line without a number', async () => {
      const { lineId } = await withCredentials();
      fetchMock.mockImplementation((input, init) =>
        (input as string).endsWith('/register')
          ? metaError(133005)
          : metaOk(input as string, init),
      );

      const res = await adminPost(`/lines/${lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(400);

      expect(res.body).toMatchObject({ metaCode: 133005 });
      expect((res.body as { message: string }).message).toContain(
        'El PIN no coincide',
      );
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      expect(line.phoneNumberId).toBeNull();
    });

    it('answers 409 to a number another line already has', async () => {
      const first = await withCredentials('lola');
      await adminPost(`/lines/${first.lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(200);
      const second = await withCredentials('kubbo');

      await adminPost(`/lines/${second.lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(409);
    });

    it('the registered line receives webhooks signed with its app secret', async () => {
      const { lineId, businessId } = await withCredentials();
      await adminPost(`/lines/${lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(200);
      const { webhookKey } = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: credentialsBody.wabaId,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '5491155550001',
                    phone_number_id: PHONE_ID,
                  },
                  messages: [
                    {
                      from: '5491100001234',
                      id: 'wamid.onboarded.1',
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
      const signature = `sha256=${createHmac('sha256', credentialsBody.appSecret).update(raw).digest('hex')}`;

      await http()
        .post(`/webhooks/whatsapp/${webhookKey}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(raw)
        .expect(200);

      const contact = await prisma.contact.findFirstOrThrow({
        where: { waId: '5491100001234' },
      });
      expect(contact.businessId).toBe(businessId);
    });

    it('subscribes the app and reads the subscriptions back', async () => {
      const { lineId } = await withCredentials();

      const res = await adminPost(`/lines/${lineId}/subscribe`).expect(200);

      expect(res.body).toEqual({
        subscribed: true,
        apps: [{ id: credentialsBody.appId, name: 'Bottega Ana' }],
        otherApps: false,
      });
      expect(
        fetchMock.mock.calls.map(([url, init]) => [url, init?.method]),
      ).toEqual([
        [`${GRAPH}/${credentialsBody.wabaId}/subscribed_apps`, 'POST'],
        [`${GRAPH}/${credentialsBody.wabaId}/subscribed_apps`, 'GET'],
      ]);
    });

    it('warns when another app is also subscribed (two bots would answer)', async () => {
      const { lineId } = await withCredentials();
      fetchMock.mockImplementation((input, init) =>
        (init?.method ?? 'GET') === 'GET' &&
        (input as string).endsWith('/subscribed_apps')
          ? json({
              data: [
                { whatsapp_business_api_data: { id: credentialsBody.appId } },
                {
                  whatsapp_business_api_data: {
                    id: '111111111111111',
                    name: 'Otro proveedor',
                  },
                },
              ],
            })
          : metaOk(input as string, init),
      );

      const res = await adminPost(`/lines/${lineId}/subscribe`).expect(200);

      expect(res.body).toMatchObject({ subscribed: true, otherApps: true });
    });

    it('explains a failed subscription', async () => {
      const { lineId } = await withCredentials();
      fetchMock.mockImplementation(() => metaError(200, 403));

      const res = await adminPost(`/lines/${lineId}/subscribe`).expect(400);

      expect(res.body).toMatchObject({ metaCode: 200 });
    });

    it('records the first confirmation that the app is published', async () => {
      const { lineId } = await createDraft();

      const first = await adminPost(`/lines/${lineId}/app-published`).expect(
        200,
      );
      const second = await adminPost(`/lines/${lineId}/app-published`).expect(
        200,
      );

      const { appPublishedAt } = first.body as { appPublishedAt: string };
      expect(typeof appPublishedAt).toBe('string');
      expect(second.body).toEqual({ appPublishedAt });
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      expect(line.appPublishedAt?.toISOString()).toBe(appPublishedAt);
      await adminPost(
        '/lines/00000000-0000-4000-8000-000000000000/app-published',
      ).expect(404);
    });

    it('requires the admin key on every line route', async () => {
      const { lineId } = await createDraft();
      for (const send of [
        () => http().put(`/admin/lines/${lineId}/credentials`).send({}),
        () => http().get(`/admin/lines/${lineId}/phone-numbers`),
        () => http().post(`/admin/lines/${lineId}/register`).send({}),
        () => http().post(`/admin/lines/${lineId}/subscribe`),
        () => http().post(`/admin/lines/${lineId}/app-published`),
      ]) {
        await send().expect(401);
      }
    });
  });

  describe('status', () => {
    const adminGet = (path: string) =>
      http().get(`/admin${path}`).set('X-Admin-Api-Key', ADMIN_KEY);

    const registered = async (slug = 'peluqueria-ana') => {
      const draft = await createDraft(slug);
      await adminPut(
        `/lines/${draft.lineId}/credentials`,
        credentialsBody,
      ).expect(200);
      await adminPost(`/lines/${draft.lineId}/register`, {
        phoneNumberId: PHONE_ID,
        pin: PIN,
      }).expect(200);
      fetchMock.mockClear();
      return draft;
    };

    const expectNoRouteSecrets = async (lineId: string, body: unknown) => {
      const line = await prisma.line.findUniqueOrThrow({
        where: { id: lineId },
      });
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(line.verifyToken);
      expect(raw).not.toContain(line.webhookKey);
      expectNoSecrets(body);
    };

    it('shows everything pending for a draft, without asking Meta', async () => {
      const { lineId } = await createDraft();

      const res = await adminGet(`/lines/${lineId}/status`).expect(200);

      expect(res.body).toEqual({
        lineId,
        step: 'draft',
        phoneNumberId: null,
        displayPhone: null,
        appPublishedAt: null,
        lastInboundAt: null,
        number: null,
        appSubscribed: null,
        otherApps: null,
        metaError: null,
        pending: [
          'credentials',
          'number',
          'subscription',
          'app_published',
          'first_message',
        ],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      await expectNoRouteSecrets(lineId, res.body);
    });

    it("shows Meta's view of a registered line and what is left", async () => {
      const { lineId } = await registered();

      const res = await adminGet(`/lines/${lineId}/status`).expect(200);

      expect(res.body).toMatchObject({
        step: 'registered',
        phoneNumberId: PHONE_ID,
        number: {
          id: PHONE_ID,
          verifiedName: 'Peluquería Ana',
          nameStatus: 'APPROVED',
          codeVerificationStatus: 'VERIFIED',
          qualityRating: 'GREEN',
        },
        appSubscribed: true,
        otherApps: false,
        metaError: null,
        pending: ['app_published', 'first_message'],
      });
      await expectNoRouteSecrets(lineId, res.body);
    });

    it('stops listing the app as pending once the team confirms it is published', async () => {
      const { lineId } = await registered();
      await adminPost(`/lines/${lineId}/app-published`).expect(200);

      const res = await adminGet(`/lines/${lineId}/status`).expect(200);

      expect((res.body as { pending: string[] }).pending).toEqual([
        'first_message',
      ]);
    });

    it('reuses the Meta lookups for 60 seconds', async () => {
      const { lineId } = await registered();

      await adminGet(`/lines/${lineId}/status`).expect(200);
      const calls = fetchMock.mock.calls.length;
      await adminGet(`/lines/${lineId}/status`).expect(200);

      expect(calls).toBe(2);
      expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it('does not cache a lookup that started before the credentials changed', async () => {
      const { lineId } = await registered();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fetchMock.mockImplementation(async (input, init) => {
        if ((input as string).startsWith(`${GRAPH}/${PHONE_ID}?`)) {
          await held;
        }
        return metaOk(input as string, init);
      });

      const slow = adminGet(`/lines/${lineId}/status`).then((r) => r);
      await vi.waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) =>
            (url as string).startsWith(`${GRAPH}/${PHONE_ID}?`),
          ),
        ).toBe(true),
      );
      await adminPut(`/lines/${lineId}/credentials`, credentialsBody).expect(
        200,
      );
      release();
      expect((await slow).status).toBe(200);
      fetchMock.mockClear();

      await adminGet(`/lines/${lineId}/status`).expect(200);

      expect(fetchMock).toHaveBeenCalled();
    });

    it('explains a failed Meta lookup and keeps the stored state', async () => {
      const { lineId } = await registered();
      fetchMock.mockImplementation(() => metaError(190, 401));

      const res = await adminGet(`/lines/${lineId}/status`).expect(200);

      expect(res.body).toMatchObject({
        step: 'registered',
        number: null,
        appSubscribed: null,
        pending: ['subscription', 'app_published', 'first_message'],
      });
      expect((res.body as { metaError: string }).metaError).toContain(
        'El token no es válido o venció',
      );
    });

    it("shows an OWNER only their business's lines; an AGENT gets 403", async () => {
      const a = await registered('lola');
      const b = await createDraft('kubbo');
      const owner = await sessionOf(a.businessId, 'olga@example.com', 'OWNER');
      const agent = await sessionOf(a.businessId, 'ana@example.com', 'AGENT');
      const status = (businessId: string) =>
        http().get(`/inbox/businesses/${businessId}/settings/whatsapp`);

      const res = await status(a.businessId).set('Cookie', owner).expect(200);

      const lines = (res.body as { lines: Array<{ lineId: string }> }).lines;
      expect(lines.map((l) => l.lineId)).toEqual([a.lineId]);
      await expectNoRouteSecrets(a.lineId, res.body);
      await status(b.businessId).set('Cookie', owner).expect(403);
      await status(a.businessId).set('Cookie', agent).expect(403);
      await adminGet(
        '/lines/00000000-0000-4000-8000-000000000000/status',
      ).expect(404);
    });
  });
});
