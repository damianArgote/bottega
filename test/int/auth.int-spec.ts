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
import { hashRefreshToken } from '../../src/auth/session-tokens.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { resetDb } from './helpers.js';

// Must match INBOX_ORIGIN in vitest.config.int.ts.
const INBOX_ORIGIN = 'https://inbox.test';
const PASSWORD = 'una clave larga';

/** name → raw Set-Cookie line. */
function cookies(res: request.Response): Record<string, string> {
  const header = res.headers['set-cookie'] as unknown;
  const lines = Array.isArray(header) ? (header as string[]) : [];
  return Object.fromEntries(lines.map((line) => [line.split('=')[0]!, line]));
}

/** The cookie's value from a Set-Cookie line. */
const value = (line: string | undefined) =>
  line?.split(';')[0]?.split('=').slice(1).join('=') ?? '';

describe('Auth (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
  let businessId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: (keys: string[]) => limiter.attempt(keys) })
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

  beforeEach(async () => {
    await resetDb(prisma);
    limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    await users.addToBusiness(businessId, {
      email: 'ana@example.com',
      name: 'Ana',
      password: PASSWORD,
      role: 'OWNER',
    });
  });

  const http = () => request(app.getHttpServer());
  const login = (
    email = 'ana@example.com',
    password = PASSWORD,
    ip = '10.0.0.1',
  ) =>
    http()
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  describe('login', () => {
    it('sets the session and refresh cookies with the right flags', async () => {
      const res = await login('  ANA@example.com ').expect(200);

      expect(res.body).toEqual({
        user: {
          id: expect.any(String) as unknown,
          email: 'ana@example.com',
          name: 'Ana',
          mustChangePassword: false,
        },
      });
      const { bottega_session: session, bottega_refresh: refresh } =
        cookies(res);
      expect(session).toMatch(/; Max-Age=900;/);
      expect(session).toMatch(/; Path=\//);
      expect(refresh).toMatch(/; Max-Age=1209600;/);
      expect(refresh).toMatch(/; Path=\/auth/);
      for (const line of [session, refresh]) {
        expect(line).toMatch(/; HttpOnly/);
        expect(line).toMatch(/; Secure/);
        expect(line).toMatch(/; SameSite=Lax/);
      }
      // Only the hash of the refresh token is stored.
      const [stored] = await prisma.refreshToken.findMany();
      expect(stored?.tokenHash).toBe(hashRefreshToken(value(refresh)));
      expect(JSON.stringify(stored)).not.toContain(value(refresh));
    });

    it.each([
      ['a wrong password', 'ana@example.com', 'otra clave larga'],
      ['an unknown email', 'nadie@example.com', PASSWORD],
    ])(
      'answers 401 without cookies for %s',
      async (_label, email, password) => {
        const res = await login(email, password).expect(401);

        expect(res.body).toMatchObject({
          message: 'Invalid email or password',
        });
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(await prisma.refreshToken.count()).toBe(0);
      },
    );

    it('answers 401 for an inactive user', async () => {
      await prisma.user.updateMany({ data: { active: false } });

      await login().expect(401);
    });

    it('returns 400 for a malformed body', async () => {
      await http().post('/auth/login').send({ email: 'x' }).expect(400);
    });

    it('allows 5 attempts per email a minute; the 6th is 429 even with the right password', async () => {
      for (let i = 0; i < 5; i += 1) {
        await login('ana@example.com', 'mala clave 123', `10.0.1.${i}`).expect(
          401,
        );
      }

      await login('ana@example.com', PASSWORD, '10.0.2.1').expect(429);
    });

    it('allows 5 attempts per IP a minute, whatever the email', async () => {
      for (let i = 0; i < 5; i += 1) {
        await login(`user${i}@example.com`, PASSWORD, '10.0.3.1').expect(401);
      }

      await login('ana@example.com', PASSWORD, '10.0.3.1').expect(429);
      await login('ana@example.com', PASSWORD, '10.0.3.2').expect(200);
    });
  });

  describe('me', () => {
    it('returns the user with their businesses and roles', async () => {
      const session = cookies(await login()).bottega_session!;

      const res = await http()
        .get('/auth/me')
        .set('Cookie', session.split(';')[0]!)
        .expect(200);

      expect(res.body).toEqual({
        user: {
          id: expect.any(String) as unknown,
          email: 'ana@example.com',
          name: 'Ana',
          mustChangePassword: false,
        },
        staff: false,
        businesses: [
          {
            id: businessId,
            name: 'botsuite46',
            slug: 'botsuite46',
            role: 'OWNER',
          },
        ],
      });
    });

    it('answers 401 without a session, with a bad one, or for a deactivated user', async () => {
      await http().get('/auth/me').expect(401);
      await http()
        .get('/auth/me')
        .set('Cookie', 'bottega_session=not-a-jwt')
        .expect(401);

      const session = cookies(await login()).bottega_session!.split(';')[0]!;
      await prisma.user.updateMany({ data: { active: false } });
      await http().get('/auth/me').set('Cookie', session).expect(401);
    });
  });

  describe('refresh', () => {
    const refresh = (cookie: string) =>
      http().post('/auth/refresh').set('Cookie', cookie);

    it('rotates the refresh token: the new one works and the old one stops working', async () => {
      const first = cookies(await login()).bottega_refresh!.split(';')[0]!;

      const res = await refresh(first).expect(200);
      const next = cookies(res);
      expect(next.bottega_session).toMatch(/; HttpOnly/);
      const second = next.bottega_refresh!.split(';')[0]!;
      expect(second).not.toBe(first);

      await refresh(first).expect(401);
      await refresh(second).expect(200);
    });

    it('answers 401 without a cookie, for an expired token or an inactive user', async () => {
      await http().post('/auth/refresh').expect(401);

      const token = cookies(await login()).bottega_refresh!.split(';')[0]!;
      await prisma.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await refresh(token).expect(401);

      const other = cookies(await login()).bottega_refresh!.split(';')[0]!;
      await prisma.user.updateMany({ data: { active: false } });
      await refresh(other).expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token and clears both cookies', async () => {
      const set = cookies(await login());
      const cookie = [
        set.bottega_session!.split(';')[0],
        set.bottega_refresh!.split(';')[0],
      ].join('; ');

      const res = await http()
        .post('/auth/logout')
        .set('Cookie', cookie)
        .expect(204);

      const cleared = cookies(res);
      expect(value(cleared.bottega_session)).toBe('');
      expect(value(cleared.bottega_refresh)).toBe('');
      expect(cleared.bottega_refresh).toMatch(/; Path=\/auth/);
      expect(
        (await prisma.refreshToken.findFirstOrThrow()).revokedAt,
      ).not.toBeNull();
      await http()
        .post('/auth/refresh')
        .set('Cookie', set.bottega_refresh!.split(';')[0]!)
        .expect(401);
    });

    it('answers 204 without a session too', async () => {
      await http().post('/auth/logout').expect(204);
    });
  });

  describe('CORS', () => {
    it('allows INBOX_ORIGIN with credentials and nothing else', async () => {
      const allowed = await http()
        .options('/auth/login')
        .set('Origin', INBOX_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');
      expect(allowed.headers['access-control-allow-origin']).toBe(INBOX_ORIGIN);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const other = await http()
        .options('/auth/login')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('change password', () => {
    const change = (cookie: string, body: object) =>
      http().post('/auth/change-password').set('Cookie', cookie).send(body);
    const sessionCookies = (res: request.Response) => {
      const set = cookies(res);
      return [
        set.bottega_session!.split(';')[0],
        set.bottega_refresh!.split(';')[0],
      ].join('; ');
    };

    it('changes it: the old password stops working, the new one works, and other sessions end', async () => {
      const first = sessionCookies(await login());
      const other = cookies(
        await login('ana@example.com', PASSWORD, '10.0.9.2'),
      ).bottega_refresh!.split(';')[0]!;

      const res = await change(first, {
        currentPassword: PASSWORD,
        newPassword: 'una clave nueva',
      }).expect(200);

      expect(res.body).toMatchObject({
        user: { email: 'ana@example.com', mustChangePassword: false },
      });
      expect(cookies(res).bottega_session).toMatch(/; HttpOnly/);
      await login('ana@example.com', PASSWORD, '10.0.9.3').expect(401);
      await login('ana@example.com', 'una clave nueva', '10.0.9.4').expect(200);
      await http().post('/auth/refresh').set('Cookie', other).expect(401);
    });

    it('rejects a wrong current password, a short or unchanged new one, and no session', async () => {
      const session = sessionCookies(await login());

      await change(session, {
        currentPassword: 'otra cosa larga',
        newPassword: 'una clave nueva',
      }).expect(401);
      await change(session, {
        currentPassword: PASSWORD,
        newPassword: 'corta',
      }).expect(400);
      await change(session, {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      }).expect(400);
      await http()
        .post('/auth/change-password')
        .send({ currentPassword: PASSWORD, newPassword: 'una clave nueva' })
        .expect(401);
    });

    it('login and me say when the password must be changed, and changing it clears the flag', async () => {
      await prisma.user.updateMany({ data: { mustChangePassword: true } });

      const logged = await login().expect(200);
      expect(logged.body).toMatchObject({ user: { mustChangePassword: true } });
      const session = sessionCookies(logged);
      const me = await http()
        .get('/auth/me')
        .set('Cookie', session.split('; ')[0]!)
        .expect(200);
      expect(me.body).toMatchObject({ user: { mustChangePassword: true } });

      await change(session, {
        currentPassword: PASSWORD,
        newPassword: 'una clave nueva',
      }).expect(200);

      expect((await prisma.user.findFirstOrThrow()).mustChangePassword).toBe(
        false,
      );
    });
  });
});
