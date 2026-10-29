import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { usageDay, usageMonth } from '../../src/ai/ai-usage.service.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import {
  InMemoryLoginRateLimiter,
  LOGIN_RATE_LIMITER,
} from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import {
  ConversationsService,
  type LineRef,
} from '../../src/conversations/conversations.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb, textEvent } from './helpers.js';

const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';

describe('AI limits and usage routes (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let conversations: ConversationsService;
  let a: string;
  let b: string;
  let lineA: LineRef;
  let lineB: LineRef;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue(new InMemoryLoginRateLimiter({ max: 1000, windowMs: 60_000 }))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
    conversations = app.get(ConversationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    lineA = await createLine(prisma, { slug: 'lola', phoneNumberId: '222' });
    a = lineA.businessId;
    const defaultLine = await prisma.line.findFirstOrThrow({
      where: { business: { slug: 'botsuite46' } },
    });
    lineB = { lineId: defaultLine.id, businessId: defaultLine.businessId };
    b = lineB.businessId;
    await users.addToBusiness(a, {
      email: 'olga@example.com',
      name: 'Olga',
      password: PASSWORD,
      role: 'OWNER',
    });
    await users.addToBusiness(a, {
      email: 'ana@example.com',
      name: 'Ana',
      password: PASSWORD,
      role: 'AGENT',
    });
    await users.addToBusiness(b, {
      email: 'bruno@example.com',
      name: 'Bruno',
      password: PASSWORD,
      role: 'OWNER',
    });
  });

  const http = () => request(app.getHttpServer());

  const sessionOf = async (email: string) => {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };

  /** `count` usage rows on a new conversation of `line`. */
  const seedUsage = async (
    line: LineRef,
    count: number,
    outcome: 'OK' | 'ERROR' | 'LIMITED' = 'OK',
    day = usageDay(new Date()),
  ) => {
    const waId = `54911${String(Math.random()).slice(2, 10)}`;
    await conversations.recordInbound(textEvent(`wamid.${waId}`, waId), line);
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { lineId: line.lineId, contact: { waId } },
    });
    await prisma.aiUsage.createMany({
      data: Array.from({ length: count }, () => ({
        conversationId: conversation.id,
        day,
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        outcome,
      })),
    });
  };

  const limits = { aiMonthlyCap: 100, aiDailyCapPerConversation: 5 };

  it('PUT /admin/businesses/:id/limits requires the ADMIN_API_KEY', async () => {
    await http().put(`/admin/businesses/${a}/limits`).send(limits).expect(401);
    await http().get(`/admin/businesses/${a}/limits`).expect(401);
    await http().get(`/admin/businesses/${a}/usage`).expect(401);

    await http()
      .put(`/admin/businesses/${a}/limits`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send(limits)
      .expect(200, { ...limits, catalogItemCap: null });
    await http()
      .get(`/admin/businesses/${a}/limits`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200, { ...limits, catalogItemCap: null });
  });

  it('null goes back to the default; out-of-range values are rejected', async () => {
    const put = (body: unknown) =>
      http()
        .put(`/admin/businesses/${a}/limits`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send(body as object);
    await put(limits).expect(200);
    await put({ aiMonthlyCap: null, aiDailyCapPerConversation: null }).expect(
      200,
      {
        aiMonthlyCap: null,
        aiDailyCapPerConversation: null,
        catalogItemCap: null,
      },
    );

    for (const body of [
      { aiMonthlyCap: 0, aiDailyCapPerConversation: null },
      { aiMonthlyCap: 1_000_001, aiDailyCapPerConversation: null },
      { aiMonthlyCap: 1.5, aiDailyCapPerConversation: null },
      { aiMonthlyCap: null },
      { ...limits, extra: 1 },
      { ...limits, catalogItemCap: 0 },
    ]) {
      await put(body).expect(400);
    }
    await put({ aiMonthlyCap: 1_000_000, aiDailyCapPerConversation: 1 }).expect(
      200,
    );
  });

  it('404 when the business does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const send of [
      () => http().get(`/admin/businesses/${missing}/limits`),
      () => http().put(`/admin/businesses/${missing}/limits`).send(limits),
      () => http().get(`/admin/businesses/${missing}/usage`),
    ]) {
      await send().set('X-Admin-Api-Key', ADMIN_KEY).expect(404);
    }
  });

  it('usage counts OK and ERROR calls of the month, only of that business', async () => {
    await prisma.business.update({
      where: { id: a },
      data: { aiMonthlyCap: 8 },
    });
    await seedUsage(lineA, 2, 'OK');
    await seedUsage(lineA, 1, 'ERROR');
    await seedUsage(lineA, 3, 'LIMITED');
    // Last month and another business do not count.
    const lastMonth = new Date(usageMonth(new Date()).start.getTime() - 1);
    await seedUsage(lineA, 4, 'OK', usageDay(lastMonth));
    await seedUsage(lineB, 5, 'OK');

    const expected = {
      month: usageMonth(new Date()).label,
      used: 3,
      cap: 8,
      percent: 38,
      capReached: false,
    };
    await http()
      .get(`/admin/businesses/${a}/usage`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200, expected);
    // Any role of the business sees it.
    for (const email of ['olga@example.com', 'ana@example.com']) {
      const cookie = await sessionOf(email);
      await http()
        .get(`/inbox/businesses/${a}/settings/usage`)
        .set('Cookie', cookie)
        .expect(200, expected);
    }
    // The other business uses the environment default.
    await http()
      .get(`/admin/businesses/${b}/usage`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200, {
        month: expected.month,
        used: 5,
        cap: 5000,
        percent: 0,
        capReached: false,
      });
  });

  it('capReached once the month reaches the cap', async () => {
    await prisma.business.update({
      where: { id: a },
      data: { aiMonthlyCap: 2 },
    });
    await seedUsage(lineA, 2);

    await http()
      .get(`/admin/businesses/${a}/usage`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({
          used: 2,
          percent: 100,
          capReached: true,
        });
      });
  });

  it('GET settings/usage gives 403 to a user of another business', async () => {
    const cookie = await sessionOf('bruno@example.com');
    await http()
      .get(`/inbox/businesses/${a}/settings/usage`)
      .set('Cookie', cookie)
      .expect(403);
    await http().get(`/inbox/businesses/${a}/settings/usage`).expect(401);
  });

  it('an OWNER has no route to change the caps', async () => {
    const cookie = await sessionOf('olga@example.com');

    await http()
      .put(`/admin/businesses/${a}/limits`)
      .set('Cookie', cookie)
      .send(limits)
      .expect(401);
    for (const path of ['settings/usage', 'settings/limits', 'limits']) {
      for (const method of ['put', 'post', 'patch'] as const) {
        await http()
          [method](`/inbox/businesses/${a}/${path}`)
          .set('Cookie', cookie)
          .send(limits)
          .expect(404);
      }
    }
    await http()
      .put(`/staff/businesses/${a}/limits`)
      .set('Cookie', cookie)
      .send(limits)
      .expect((res) => expect([403, 404]).toContain(res.status));
    expect(
      await prisma.business.findUniqueOrThrow({
        where: { id: a },
        select: { aiMonthlyCap: true, aiDailyCapPerConversation: true },
      }),
    ).toEqual({ aiMonthlyCap: null, aiDailyCapPerConversation: null });
  });
});
