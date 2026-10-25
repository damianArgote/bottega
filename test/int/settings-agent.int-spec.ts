import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AI_PROVIDER, type AiProvider } from '../../src/ai/ai.provider.js';
import type {
  AgentProfileInput,
  AgentSettingsInput,
} from '../../src/agents/agent-profile.schema.js';
import { AgentsService } from '../../src/agents/agents.service.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import {
  InMemoryLoginRateLimiter,
  LOGIN_RATE_LIMITER,
} from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { PREVIEW_RATE_LIMITER } from '../../src/settings/settings.controller.js';
import { createLine, resetDb } from './helpers.js';

const PASSWORD = 'una clave larga';

const settings: AgentSettingsInput = {
  enabled: true,
  botName: 'Lola, IA de Peluquería Lola',
  persona: 'Simpática.',
  businessInfo: '## Servicios\n- Brushing: $9.000',
  faq: [{ question: '¿Atienden con turno?', answer: 'Solo con turno.' }],
  leadFields: [{ key: 'name', label: 'Nombre', required: true, kind: 'text' }],
  handoffRules: 'Si es un reclamo.',
  outOfHoursMessage: null,
  openingHours: null,
};
const adminProfile: AgentProfileInput = {
  ...settings,
  model: 'profile-model',
  demoEnabled: true,
};

describe('Backoffice agent settings (integration, HTTP)', () => {
  const respond = vi.fn<AiProvider['respond']>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let agents: AgentsService;
  let a: string;
  let b: string;
  let ownerId: string;
  let previews = new InMemoryLoginRateLimiter({ max: 20, windowMs: 3_600_000 });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: () => true })
      .overrideProvider(PREVIEW_RATE_LIMITER)
      .useValue({ attempt: (keys: string[]) => previews.attempt(keys) })
      .overrideProvider(AI_PROVIDER)
      .useValue({ respond })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
    agents = app.get(AgentsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    respond.mockReset();
    previews = new InMemoryLoginRateLimiter({ max: 20, windowMs: 3_600_000 });
    a = (await createLine(prisma, { slug: 'lola', phoneNumberId: '222' }))
      .businessId;
    b = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    await agents.put(a, adminProfile);
    ownerId = (
      await users.addToBusiness(a, {
        email: 'olga@example.com',
        name: 'Olga',
        password: PASSWORD,
        role: 'OWNER',
      })
    ).user.id;
    await users.addToBusiness(a, {
      email: 'ana@example.com',
      name: 'Ana',
      password: PASSWORD,
      role: 'AGENT',
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

  /** Response bodies of these routes. */
  type Body = {
    message: string[];
    versions: { version: number; changes: unknown[] }[];
  };
  const body = (res: { body: unknown }) => res.body as Body;

  const url = (path: string, businessId = a) =>
    `/inbox/businesses/${businessId}/settings/${path}`;

  it('an AGENT gets 403 on every agent settings route', async () => {
    const cookie = await sessionOf('ana@example.com');
    const before = await prisma.agentProfile.findUniqueOrThrow({
      where: { businessId: a },
    });

    const requests = [
      () => http().get(url('agent')),
      () => http().put(url('agent')).send(settings),
      () => http().get(url('agent/versions')),
      () => http().post(url('agent/versions/1/restore')),
      () =>
        http()
          .post(url('agent/preview'))
          .send({ messages: [{ role: 'user', content: 'Hola' }] }),
    ];
    for (const send of requests) {
      await send().set('Cookie', cookie).expect(403);
    }
    expect(
      await prisma.agentProfile.findUniqueOrThrow({ where: { businessId: a } }),
    ).toEqual(before);
    expect(respond).not.toHaveBeenCalled();
  });

  it('an OWNER of business A gets 403 on the settings of business B', async () => {
    const cookie = await sessionOf('olga@example.com');

    await http().get(url('agent', b)).set('Cookie', cookie).expect(403);
    await http()
      .put(url('agent', b))
      .set('Cookie', cookie)
      .send(settings)
      .expect(403);
  });

  it('no session is 401', async () => {
    await http().get(url('agent')).expect(401);
  });

  it('an OWNER reads the agent, including the admin-only fields', async () => {
    const cookie = await sessionOf('olga@example.com');
    const res = await http()
      .get(url('agent'))
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toMatchObject({
      ...adminProfile,
      businessId: a,
      version: 1,
      updatedBy: null,
    });
  });

  it('PUT raises the version, records who changed it and keeps model and demoEnabled', async () => {
    const cookie = await sessionOf('olga@example.com');
    const res = await http()
      .put(url('agent'))
      .set('Cookie', cookie)
      .send({ ...settings, persona: 'Seria.' })
      .expect(200);

    expect(res.body).toMatchObject({
      persona: 'Seria.',
      version: 2,
      model: 'profile-model',
      demoEnabled: true,
      updatedBy: { id: ownerId, name: 'Olga' },
    });
    expect(
      await prisma.agentProfile.findUniqueOrThrow({ where: { businessId: a } }),
    ).toMatchObject({
      persona: 'Seria.',
      version: 2,
      updatedById: ownerId,
      model: 'profile-model',
      demoEnabled: true,
    });
  });

  it('an invalid PUT is 400 with the Zod errors and changes nothing', async () => {
    const cookie = await sessionOf('olga@example.com');

    const res = await http()
      .put(url('agent'))
      .set('Cookie', cookie)
      .send({ ...settings, botName: '', leadFields: 'no' })
      .expect(400);
    expect(body(res).message).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^body\.botName: /),
        expect.stringMatching(/^body\.leadFields: /),
      ]),
    );

    for (const field of [{ model: 'gpt-x' }, { demoEnabled: false }]) {
      const admin = await http()
        .put(url('agent'))
        .set('Cookie', cookie)
        .send({ ...settings, ...field })
        .expect(400);
      expect(JSON.stringify(body(admin).message)).toContain(
        Object.keys(field)[0],
      );
    }
    expect(
      await prisma.agentProfile.findUniqueOrThrow({ where: { businessId: a } }),
    ).toMatchObject({ version: 1, model: 'profile-model', demoEnabled: true });
    expect(await prisma.agentProfileVersion.count()).toBe(2); // a and b's seed
  });

  it('versions lists each version with its date, author and changed fields', async () => {
    const cookie = await sessionOf('olga@example.com');
    await http()
      .put(url('agent'))
      .set('Cookie', cookie)
      .send({ ...settings, persona: 'Seria.' })
      .expect(200);

    const res = await http()
      .get(url('agent/versions'))
      .set('Cookie', cookie)
      .expect(200);

    expect(body(res).versions).toHaveLength(2);
    expect(body(res).versions[0]).toEqual({
      version: 2,
      createdAt: expect.any(String) as unknown,
      author: { id: ownerId, name: 'Olga' },
      changes: [{ field: 'persona', before: 'Simpática.', after: 'Seria.' }],
    });
    expect(body(res).versions[1]).toMatchObject({
      version: 1,
      author: null,
      changes: expect.arrayContaining([
        { field: 'persona', before: null, after: 'Simpática.' },
      ]) as unknown,
    });
  });

  it('versions shows the latest 20, the oldest compared with the one before it', async () => {
    for (let i = 2; i <= 22; i += 1) {
      await agents.putSettings(a, { ...settings, persona: `v${i}` }, ownerId);
    }

    const cookie = await sessionOf('olga@example.com');

    const res = await http()
      .get(url('agent/versions'))

      .set('Cookie', cookie)
      .expect(200);

    expect(body(res).versions.map((v) => v.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => 22 - i),
    );
    expect(body(res).versions.at(-1)!.changes).toEqual([
      { field: 'persona', before: 'v2', after: 'v3' },
    ]);
  });

  it('restoring a version saves it as a new version and keeps model and demoEnabled', async () => {
    const cookie = await sessionOf('olga@example.com');
    await http()
      .put(url('agent'))
      .set('Cookie', cookie)
      .send({ ...settings, persona: 'Seria.' })
      .expect(200);
    await agents.put(a, { ...adminProfile, persona: 'Seria.', model: 'm2' });

    const res = await http()
      .post(url('agent/versions/1/restore'))
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toMatchObject({
      persona: 'Simpática.',
      version: 4,
      model: 'm2',
      updatedBy: { id: ownerId, name: 'Olga' },
    });
    const versions = await prisma.agentProfileVersion.findMany({
      where: { businessId: a },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(versions[3]).toMatchObject({
      createdById: ownerId,
      snapshot: { ...adminProfile, model: 'm2' },
    });
  });

  it('restoring an unknown or no longer valid version changes nothing', async () => {
    const cookie = await sessionOf('olga@example.com');
    await http()
      .post(url('agent/versions/9/restore'))
      .set('Cookie', cookie)
      .expect(404);
    await http()
      .post(url('agent/versions/abc/restore'))
      .set('Cookie', cookie)
      .expect(400);
    await prisma.agentProfileVersion.update({
      where: { businessId_version: { businessId: a, version: 1 } },
      data: { snapshot: { botName: '' } },
    });

    const res = await http()
      .post(url('agent/versions/1/restore'))
      .set('Cookie', cookie)
      .expect(409);

    expect((res.body as { code: string }).code).toBe('VERSION_INVALID');
    expect(
      await prisma.agentProfile.findUniqueOrThrow({ where: { businessId: a } }),
    ).toMatchObject({ version: 1 });
  });

  it('preview runs one turn without sending, up to 20 per hour per business', async () => {
    respond.mockResolvedValue({
      outputText: 'Hola, soy Lola.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'served-model',
    });
    const cookie = await sessionOf('olga@example.com');
    const preview = () =>
      http()
        .post(url('agent/preview'))
        .set('Cookie', cookie)
        .send({ messages: [{ role: 'user', content: 'Hola' }] });

    const first = await preview().expect(200);
    expect(first.body).toMatchObject({
      reply: 'Hola, soy Lola.',
      agentProfileVersion: 1,
    });
    for (let i = 2; i <= 20; i += 1) {
      await preview().expect(200);
    }
    await preview().expect(429);

    expect(respond).toHaveBeenCalledTimes(20);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.aiUsage.count()).toBe(0);
  });

  it('an invalid preview body is 400 and does not use the hourly limit', async () => {
    const cookie = await sessionOf('olga@example.com');
    previews = new InMemoryLoginRateLimiter({ max: 1, windowMs: 3_600_000 });
    respond.mockResolvedValue({
      outputText: 'Hola.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'served-model',
    });

    await http()
      .post(url('agent/preview'))
      .set('Cookie', cookie)
      .send({ messages: [] })
      .expect(400);
    await http()
      .post(url('agent/preview'))
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'Hola' }] })
      .expect(200);
  });
});
