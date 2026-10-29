import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { LOGIN_RATE_LIMITER } from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';

describe('Staff role (integration)', () => {
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
});
