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
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb, textEvent } from './helpers.js';

const PASSWORD = 'una clave larga';

describe('Inbox business access (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let a: string;
  let b: string;
  let limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });

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
    a = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    b = (await createLine(prisma, { slug: 'lola', phoneNumberId: '222' }))
      .businessId;
    await users.addToBusiness(a, {
      email: 'ana@example.com',
      name: 'Ana',
      password: PASSWORD,
      role: 'AGENT',
    });
  });

  const http = () => request(app.getHttpServer());

  /** Logs in (each test uses its own IP: the login limit is per IP). */
  let ip = 0;
  const sessionOf = async (email: string) => {
    ip += 1;
    const res = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', `10.1.0.${ip}`)
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };

  const inbox = (businessId: string, cookie?: string) => {
    const req = http().get(`/inbox/businesses/${businessId}`);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  it('a member gets their business and role', async () => {
    const res = await inbox(a, await sessionOf('ana@example.com')).expect(200);

    expect(res.body).toEqual({
      business: { id: a, name: 'botsuite46', slug: 'botsuite46' },
      role: 'AGENT',
    });
  });

  it('a user of business A gets 403 on a route of business B', async () => {
    const res = await inbox(b, await sessionOf('ana@example.com')).expect(403);

    expect(JSON.stringify(res.body)).not.toContain('lola');
  });

  it('an unknown business is also 403, so business ids cannot be probed', async () => {
    await inbox(
      '00000000-0000-4000-8000-000000000000',
      await sessionOf('ana@example.com'),
    ).expect(403);
  });

  it('a user in both businesses gets each one with its own role', async () => {
    await users.addToBusiness(b, {
      email: 'ana@example.com',
      name: 'Ana',
      password: PASSWORD,
      role: 'OWNER',
    });
    const session = await sessionOf('ana@example.com');

    expect((await inbox(a, session).expect(200)).body).toMatchObject({
      role: 'AGENT',
    });
    expect((await inbox(b, session).expect(200)).body).toMatchObject({
      role: 'OWNER',
    });
  });

  it('answers 401 without a session or for a deactivated user, and 400 for a malformed id', async () => {
    await inbox(a).expect(401);
    const session = await sessionOf('ana@example.com');
    await inbox('abc', session).expect(400);

    await prisma.user.updateMany({ data: { active: false } });
    await inbox(a, session).expect(401);
  });

  it('losing the membership takes the access away at once', async () => {
    const session = await sessionOf('ana@example.com');
    await prisma.membership.deleteMany();

    await inbox(a, session).expect(403);
  });

  describe('conversation actions over HTTP', () => {
    const conversationOf = async () => {
      await app
        .get(ConversationsService)
        .recordInbound({ ...textEvent('wamid.http.1'), timestamp: new Date() });
      return (await prisma.conversation.findFirstOrThrow()).id;
    };
    const act = (cookie: string, id: string, action: string, body?: object) =>
      http()
        .post(`/inbox/businesses/${a}/conversations/${id}/${action}`)
        .set('Cookie', cookie)
        .send(body ?? {});

    it('take, then another member gets 409; hand back, release and resolve answer with the new state', async () => {
      await users.addToBusiness(a, {
        email: 'beto@example.com',
        name: 'Beto',
        password: PASSWORD,
        role: 'AGENT',
      });
      const id = await conversationOf();
      const ana = await sessionOf('ana@example.com');
      const beto = await sessionOf('beto@example.com');

      const taken = await act(ana, id, 'take').expect(200);
      expect(taken.body).toMatchObject({
        id,
        status: 'OPEN',
        assignedTo: { name: 'Ana' },
        paused: false,
      });
      const conflict = await act(beto, id, 'take').expect(409);
      expect(conflict.body).toMatchObject({ code: 'ALREADY_TAKEN' });
      await act(beto, id, 'take', { force: true }).expect(403);

      expect((await act(ana, id, 'handback').expect(200)).body).toMatchObject({
        assignedTo: null,
        paused: false,
      });
      expect((await act(ana, id, 'release').expect(200)).body).toMatchObject({
        paused: true,
      });
      expect((await act(ana, id, 'resolve').expect(200)).body).toMatchObject({
        status: 'RESOLVED',
      });
    });

    it('validates the conversation id and the body, and 404s for another business', async () => {
      const id = await conversationOf();
      const ana = await sessionOf('ana@example.com');

      await act(ana, 'abc', 'take').expect(400);
      await act(ana, id, 'take', { force: 'yes' }).expect(400);
      await act(ana, '00000000-0000-4000-8000-000000000000', 'take').expect(
        404,
      );
    });
  });
});
