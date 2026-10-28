import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
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
import { resetDb, testConfig } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const BASE_URL = 'https://bottega.example.com';
const GRAPH = 'https://graph.facebook.com/v26.0';
const PASSWORD = 'una clave larga';

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
});
