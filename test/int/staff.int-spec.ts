import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { LOGIN_RATE_LIMITER } from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { GraphOnboardingClient } from '../../src/whatsapp/graph-onboarding.client.js';
import { GraphWhatsAppClient } from '../../src/whatsapp/graph-whatsapp.client.js';
import { createLine, resetDb } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const GRAPH = 'https://graph.facebook.com/v26.0';
const WABA = '800000000000001';
const APP = '900000000000001';
const PHONE = '700000000000001';
const PIN = '482915';
const APP_SECRET = 'client-app-secret-value';
const TOKEN = 'EAAG-client-system-user-token-value';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** Answers like Meta for one client's happy path. */
function meta(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const number = {
    id: PHONE,
    display_phone_number: '+54 9 11 5555-0001',
    verified_name: 'Peluquería Ana',
    code_verification_status: 'VERIFIED',
    name_status: 'APPROVED',
    quality_rating: 'GREEN',
  };
  if (url.startsWith(`${GRAPH}/${WABA}?`))
    return json({ id: WABA, name: 'Ana' });
  if (url.startsWith(`${GRAPH}/${APP}?`)) return json({ id: APP });
  if (url.startsWith(`${GRAPH}/${WABA}/phone_numbers?`))
    return json({ data: [number] });
  if (url.startsWith(`${GRAPH}/${PHONE}?`)) return json(number);
  if (url === `${GRAPH}/${PHONE}/register`) return json({ success: true });
  if (url === `${GRAPH}/${WABA}/subscribed_apps`)
    return method === 'POST'
      ? json({ success: true })
      : json({ data: [{ whatsapp_business_api_data: { id: APP } }] });
  throw new Error(`unexpected Meta call: ${method} ${url}`);
}

describe('Staff role (integration)', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let a: string;
  let b: string;
  let olga: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    users = app.get(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  const add = async (
    businessId: string,
    email: string,
    role: 'OWNER' | 'AGENT',
  ) =>
    (
      await users.addToBusiness(businessId, {
        email,
        name: email.split('@')[0]!,
        password: PASSWORD,
        role,
      })
    ).user.id;

  beforeEach(async () => {
    await resetDb(prisma);
    a = (await createLine(prisma, { slug: 'lola', phoneNumberId: '222' }))
      .businessId;
    b = (await createLine(prisma, { slug: 'kubbo', phoneNumberId: '333' }))
      .businessId;
    olga = await add(a, 'olga@example.com', 'OWNER');
    fetchMock.mockReset();
    fetchMock.mockImplementation((input, init) => meta(input as string, init));
  });

  const http = () => request(app.getHttpServer());
  const sessionOf = async (email: string) => {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return cookies
      .find((c) => c.startsWith('bottega_session='))!
      .split(';')[0]!;
  };
  const setStaff = (userId: string, staff: unknown, key = ADMIN_KEY) =>
    http()
      .put(`/admin/users/${userId}/staff`)
      .set('X-Admin-Api-Key', key)
      .send({ staff });

  describe('granting it', () => {
    it('is done with the admin API only', async () => {
      const res = await setStaff(olga, true).expect(200);

      expect(res.body).toEqual({ id: olga, staff: true });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: olga } });
      expect(user.staff).toBe(true);

      await setStaff(olga, false).expect(200, { id: olga, staff: false });
    });

    it('requires the admin key, a known user and a boolean', async () => {
      await http()
        .put(`/admin/users/${olga}/staff`)
        .send({ staff: true })
        .expect(401);
      await setStaff(olga, true, 'wrong-key').expect(401);
      await setStaff('00000000-0000-4000-8000-000000000000', true).expect(404);
      await setStaff(olga, 'yes').expect(400);
      await setStaff('not-a-uuid', true).expect(400);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: olga } });
      expect(user.staff).toBe(false);
    });

    it('/auth/me says whether the user is staff, and nothing else changes', async () => {
      const cookie = await sessionOf('olga@example.com');
      const before = (
        await http().get('/auth/me').set('Cookie', cookie).expect(200)
      ).body as Record<string, unknown>;
      expect(before['staff']).toBe(false);

      await setStaff(olga, true).expect(200);
      const after = (
        await http().get('/auth/me').set('Cookie', cookie).expect(200)
      ).body as Record<string, unknown>;

      expect(after).toEqual({ ...before, staff: true });
      expect(b).toBeTruthy();
    });
  });

  describe('/staff routes', () => {
    const staffSession = async () => {
      await setStaff(olga, true).expect(200);
      return sessionOf('olga@example.com');
    };

    /** Every /staff route, with a body that would pass validation. */
    const everyRoute = (lineId: string, businessId: string) => [
      () => http().get('/staff/lines/status'),
      () =>
        http()
          .post('/staff/businesses')
          .send({ name: 'X', slug: 'x', botName: 'X' }),
      () => http().post(`/staff/businesses/${businessId}/lines`),
      () =>
        http()
          .put(`/staff/lines/${lineId}/credentials`)
          .send({
            wabaId: WABA,
            appId: APP,
            appSecret: APP_SECRET,
            accessToken: TOKEN,
          }),
      () => http().get(`/staff/lines/${lineId}/phone-numbers`),
      () =>
        http()
          .post(`/staff/lines/${lineId}/register`)
          .send({ phoneNumberId: PHONE, pin: PIN }),
      () => http().post(`/staff/lines/${lineId}/subscribe`),
      () => http().post(`/staff/lines/${lineId}/app-published`),
      () =>
        http()
          .post(`/staff/businesses/${businessId}/owners`)
          .send({ email: 'nuevo@example.com', name: 'Nuevo' }),
    ];

    it('an OWNER or an AGENT without the role gets 403 on every route; no session, 401', async () => {
      await add(a, 'ana@example.com', 'AGENT');
      const line = await prisma.line.findFirstOrThrow({
        where: { businessId: a },
      });
      const owner = await sessionOf('olga@example.com');
      const agent = await sessionOf('ana@example.com');

      for (const send of everyRoute(line.id, a)) {
        await send().set('Cookie', owner).expect(403);
        await send().set('Cookie', agent).expect(403);
        await send().expect(401);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await prisma.business.count({ where: { slug: 'x' } })).toBe(0);
    });

    it('onboards a client end to end, without secrets in any response', async () => {
      const logged: string[] = [];
      vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
        logged.push(String(m));
      });
      const cookie = await staffSession();
      const call = <T>(req: request.Test, status: number) =>
        req
          .set('Cookie', cookie)
          .expect(status)
          .then((r) => r.body as T);
      const bodies: unknown[] = [];

      const business = await call<{ id: string }>(
        http().post('/staff/businesses').send({
          name: 'Peluquería Ana',
          slug: 'peluqueria-ana',
          botName: 'Ana, IA de Peluquería Ana',
        }),
        201,
      );
      const draft = await call<{
        line: { id: string };
        verifyToken: string;
        webhookUrl: string | null;
      }>(http().post(`/staff/businesses/${business.id}/lines`), 201);
      expect(typeof draft.verifyToken).toBe('string');
      const lineId = draft.line.id;
      bodies.push(
        await call(
          http()
            .put(`/staff/lines/${lineId}/credentials`)
            .send({
              wabaId: WABA,
              appId: APP,
              appSecret: APP_SECRET,
              accessToken: TOKEN,
            }),
          200,
        ),
      );
      const numbers = await call<{ phoneNumbers: Array<{ id: string }> }>(
        http().get(`/staff/lines/${lineId}/phone-numbers`),
        200,
      );
      expect(numbers.phoneNumbers.map((n) => n.id)).toEqual([PHONE]);
      bodies.push(numbers);
      bodies.push(
        await call(
          http()
            .post(`/staff/lines/${lineId}/register`)
            .send({ phoneNumberId: PHONE, pin: PIN }),
          200,
        ),
      );
      bodies.push(
        await call(http().post(`/staff/lines/${lineId}/subscribe`), 200),
      );
      bodies.push(
        await call(http().post(`/staff/lines/${lineId}/app-published`), 200),
      );
      const owner = await call<{
        user: { email: string; role: string };
        temporaryPassword: string;
      }>(
        http()
          .post(`/staff/businesses/${business.id}/owners`)
          .send({ email: 'ana@peluqueria.com', name: 'Ana' }),
        201,
      );
      expect(owner.user).toMatchObject({
        email: 'ana@peluqueria.com',
        role: 'OWNER',
      });
      const status = await call<{
        lines: Array<{
          lineId: string;
          number: { qualityRating: string } | null;
          pending: string[];
        }>;
      }>(http().get('/staff/lines/status'), 200);
      bodies.push(status);

      const line = status.lines.find((l) => l.lineId === lineId)!;
      expect(line.number?.qualityRating).toBe('GREEN');
      expect(line.pending).toEqual(['first_message']);
      const raw = JSON.stringify(bodies);
      for (const secret of [APP_SECRET, TOKEN, PIN, draft.verifyToken]) {
        expect(raw).not.toContain(secret);
      }
      // The new owner logs in with the temporary password and must change it.
      const login = await http()
        .post('/auth/login')
        .send({
          email: 'ana@peluqueria.com',
          password: owner.temporaryPassword,
        })
        .expect(200);
      expect(
        (login.body as { user: { mustChangePassword: boolean } }).user
          .mustChangePassword,
      ).toBe(true);
      // Audit log: who did what, never a secret.
      const audit = logged.filter((m) => m.startsWith(`Staff user ${olga}`));
      expect(audit).toHaveLength(7);
      expect(audit).toContain(
        `Staff user ${olga} registered the number of line ${lineId}`,
      );
      for (const secret of [APP_SECRET, TOKEN, PIN, owner.temporaryPassword]) {
        expect(logged.join('\n')).not.toContain(secret);
      }
      vi.restoreAllMocks();
    });

    it('only creates draft lines', async () => {
      const cookie = await staffSession();

      await http()
        .post(`/staff/businesses/${b}/lines`)
        .set('Cookie', cookie)
        .send({
          phoneNumberId: PHONE,
          wabaId: WABA,
          appId: APP,
          appSecret: APP_SECRET,
          accessToken: TOKEN,
        })
        .expect(400);

      expect(await prisma.line.count({ where: { businessId: b } })).toBe(1);
    });

    it('removing the role cuts access on the next request, without logging out', async () => {
      const cookie = await staffSession();
      await http().get('/staff/lines/status').set('Cookie', cookie).expect(200);

      await setStaff(olga, false).expect(200);

      await http().get('/staff/lines/status').set('Cookie', cookie).expect(403);
      await http().get('/auth/me').set('Cookie', cookie).expect(200);
    });

    it("does not open other businesses' conversations, leads or agent", async () => {
      const cookie = await staffSession();

      for (const path of [
        `/inbox/businesses/${b}/conversations`,
        `/inbox/businesses/${b}/leads`,
        `/inbox/businesses/${b}/settings/agent`,
        `/inbox/businesses/${b}/settings/whatsapp`,
      ]) {
        await http().get(path).set('Cookie', cookie).expect(403);
      }
    });
  });
});
