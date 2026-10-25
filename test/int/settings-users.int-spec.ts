import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AI_PROVIDER } from '../../src/ai/ai.provider.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { LOGIN_RATE_LIMITER } from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

const PASSWORD = 'una clave larga';

interface Member {
  id: string;
  email: string;
  role: string;
  active: boolean;
  mustChangePassword: boolean;
}

describe('Backoffice users (integration, HTTP)', () => {
  const respond = vi.fn();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let a: string;
  let b: string;
  let olga: string;
  let ana: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: () => true })
      .overrideProvider(AI_PROVIDER)
      .useValue({ respond })
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
    ana = await add(a, 'ana@example.com', 'AGENT');
  });

  const http = () => request(app.getHttpServer());

  const login = (email: string, password = PASSWORD) =>
    http().post('/auth/login').send({ email, password });
  const sessionOf = async (email: string, password = PASSWORD) => {
    const res = await login(email, password).expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };

  const users$ = (businessId = a) =>
    `/inbox/businesses/${businessId}/settings/users`;

  it('an AGENT gets 403 on every /settings route', async () => {
    const cookie = await sessionOf('ana@example.com');
    const settings = `/inbox/businesses/${a}/settings`;
    const requests = [
      () => http().get(`${settings}/agent`),
      () => http().put(`${settings}/agent`).send({}),
      () => http().get(`${settings}/agent/versions`),
      () => http().post(`${settings}/agent/versions/1/restore`),
      () => http().post(`${settings}/agent/preview`).send({}),
      () => http().get(`${settings}/users`),
      () =>
        http()
          .post(`${settings}/users`)
          .send({ email: 'x@example.com', name: 'X', role: 'OWNER' }),
      () => http().patch(`${settings}/users/${ana}`).send({ role: 'OWNER' }),
      () => http().get(`/inbox/businesses/${a}/leads`),
      () => http().get(`/inbox/businesses/${a}/leads/export.csv`),
    ];

    for (const send of requests) {
      await send().set('Cookie', cookie).expect(403);
    }
    expect(
      await prisma.membership.findMany({ where: { businessId: a } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ana, role: 'AGENT' }),
      ]) as unknown,
    );
    expect(await prisma.user.count({ where: { email: 'x@example.com' } })).toBe(
      0,
    );
  });

  it('an OWNER of business A gets 403 on the users of business B', async () => {
    await add(b, 'bruno@example.com', 'OWNER');
    const cookie = await sessionOf('olga@example.com');

    const res = await http().get(users$(b)).set('Cookie', cookie).expect(403);
    expect(JSON.stringify(res.body)).not.toContain('bruno');
  });

  it('lists the people of the business with their role and state', async () => {
    await add(b, 'bruno@example.com', 'OWNER');
    const cookie = await sessionOf('olga@example.com');

    const res = await http().get(users$()).set('Cookie', cookie).expect(200);

    expect((res.body as { users: Member[] }).users).toEqual([
      expect.objectContaining({
        id: olga,
        email: 'olga@example.com',
        role: 'OWNER',
        active: true,
        mustChangePassword: false,
      }),
      expect.objectContaining({ id: ana, role: 'AGENT', active: true }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/password_?hash|\$argon/i);
  });

  it('adding a new user shows a temporary password once and forces a change', async () => {
    const cookie = await sessionOf('olga@example.com');

    const res = await http()
      .post(users$())
      .set('Cookie', cookie)
      .send({ email: ' Tomas@Example.com ', name: 'Tomás', role: 'AGENT' })
      .expect(201);

    const body = res.body as { user: Member; temporaryPassword: string };
    expect(body.user).toMatchObject({
      email: 'tomas@example.com',
      role: 'AGENT',
      active: true,
      mustChangePassword: true,
    });
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const list = await http().get(users$()).set('Cookie', cookie).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(body.temporaryPassword);

    const session = await login(
      'tomas@example.com',
      body.temporaryPassword,
    ).expect(200);
    expect(session.body).toMatchObject({ user: { mustChangePassword: true } });
  });

  it('adding an existing user only gives them the membership, keeping their password', async () => {
    await add(b, 'bruno@example.com', 'OWNER');
    const cookie = await sessionOf('olga@example.com');

    const res = await http()
      .post(users$())
      .set('Cookie', cookie)
      .send({ email: 'bruno@example.com', name: 'Otro nombre', role: 'AGENT' })
      .expect(201);

    expect(res.body).toMatchObject({
      user: { email: 'bruno@example.com', name: 'bruno', role: 'AGENT' },
      temporaryPassword: null,
    });
    await login('bruno@example.com').expect(200);
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { email: 'bruno@example.com' },
      }),
    ).toMatchObject({ mustChangePassword: false });
  });

  it('adding a member again is 409 and an invalid body is 400', async () => {
    const cookie = await sessionOf('olga@example.com');

    await http()
      .post(users$())
      .set('Cookie', cookie)
      .send({ email: 'ana@example.com', name: 'Ana', role: 'AGENT' })
      .expect(409);
    const res = await http()
      .post(users$())
      .set('Cookie', cookie)
      .send({ email: 'no-es-email', name: '', role: 'ADMIN' })
      .expect(400);
    expect((res.body as { message: string[] }).message).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^body\.email: /),
        expect.stringMatching(/^body\.name: /),
        expect.stringMatching(/^body\.role: /),
      ]) as unknown,
    );
  });

  it('a deactivated person loses this business at once, and only this one', async () => {
    await add(b, 'ana@example.com', 'AGENT');
    const anaSession = await sessionOf('ana@example.com');
    await http()
      .get(`/inbox/businesses/${a}`)
      .set('Cookie', anaSession)
      .expect(200);
    const cookie = await sessionOf('olga@example.com');

    const res = await http()
      .patch(`${users$()}/${ana}`)
      .set('Cookie', cookie)
      .send({ active: false })
      .expect(200);

    expect(res.body).toMatchObject({ id: ana, active: false, role: 'AGENT' });
    await http()
      .get(`/inbox/businesses/${a}`)
      .set('Cookie', anaSession)
      .expect(403);
    await http()
      .get(`/inbox/businesses/${b}`)
      .set('Cookie', anaSession)
      .expect(200);
    const me = await http()
      .get('/auth/me')
      .set('Cookie', anaSession)
      .expect(200);
    expect(
      (me.body as { businesses: { id: string }[] }).businesses.map((x) => x.id),
    ).toEqual([b]);

    await http()
      .patch(`${users$()}/${ana}`)
      .set('Cookie', cookie)
      .send({ active: true, role: 'OWNER' })
      .expect(200);
    const back = await http()
      .get(`/inbox/businesses/${a}`)
      .set('Cookie', anaSession)
      .expect(200);
    expect(back.body).toMatchObject({ role: 'OWNER' });
  });

  it('the last active OWNER cannot be deactivated or demoted', async () => {
    const cookie = await sessionOf('olga@example.com');

    for (const change of [{ active: false }, { role: 'AGENT' }]) {
      const res = await http()
        .patch(`${users$()}/${olga}`)
        .set('Cookie', cookie)
        .send(change)
        .expect(409);
      expect(res.body).toMatchObject({ code: 'LAST_OWNER' });
    }
    expect(
      await prisma.membership.findUniqueOrThrow({
        where: { userId_businessId: { userId: olga, businessId: a } },
      }),
    ).toMatchObject({ role: 'OWNER', active: true });
  });

  it('an OWNER whose account is disabled does not count as an active OWNER', async () => {
    const pepe = await add(a, 'pepe@example.com', 'OWNER');
    await prisma.user.update({ where: { id: pepe }, data: { active: false } });
    const cookie = await sessionOf('olga@example.com');

    const res = await http()
      .patch(`${users$()}/${olga}`)
      .set('Cookie', cookie)
      .send({ role: 'AGENT' })
      .expect(409);

    expect(res.body).toMatchObject({ code: 'LAST_OWNER' });
    expect(
      await prisma.membership.findUniqueOrThrow({
        where: { userId_businessId: { userId: olga, businessId: a } },
      }),
    ).toMatchObject({ role: 'OWNER' });
  });

  it('a change waits for a concurrent one, so two OWNERs cannot demote each other', async () => {
    const pablo = await add(a, 'pablo@example.com', 'OWNER');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let updated!: () => void;
    const pabloUpdated = new Promise<void>((resolve) => (updated = resolve));
    // Another change demotes Pablo and has not committed yet.
    const other = prisma.$transaction(
      async (tx) => {
        await tx.membership.update({
          where: { userId_businessId: { userId: pablo, businessId: a } },
          data: { role: 'AGENT' },
        });
        updated();
        await gate;
      },
      { timeout: 10_000 },
    );
    await pabloUpdated;

    const demoteOlga = users
      .updateMember(a, { userId: olga, role: 'AGENT' })
      .then(
        () => 'saved',
        (error: unknown) => error,
      );
    // Without the lock it would read Pablo as OWNER and finish meanwhile.
    const early = await Promise.race([
      demoteOlga,
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    release();
    await other;

    expect(early).toBe('waiting');
    expect(await demoteOlga).toMatchObject({
      response: { code: 'LAST_OWNER' },
    });
    expect(
      await prisma.membership.count({
        where: { businessId: a, role: 'OWNER', active: true },
      }),
    ).toBe(1);
  });

  it('an unknown user, a member of another business or an empty change is rejected', async () => {
    const bruno = await add(b, 'bruno@example.com', 'OWNER');
    const cookie = await sessionOf('olga@example.com');

    await http()
      .patch(`${users$()}/${bruno}`)
      .set('Cookie', cookie)
      .send({ role: 'AGENT' })
      .expect(404);
    await http()
      .patch(`${users$()}/not-a-uuid`)
      .set('Cookie', cookie)
      .send({ role: 'AGENT' })
      .expect(400);
    await http()
      .patch(`${users$()}/${ana}`)
      .set('Cookie', cookie)
      .send({})
      .expect(400);
    expect(
      await prisma.membership.findUniqueOrThrow({
        where: { userId_businessId: { userId: bruno, businessId: b } },
      }),
    ).toMatchObject({ role: 'OWNER' });
  });
});
