import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AdminService } from '../src/admin/admin.service.js';
import { BusinessesService } from '../src/admin/businesses.service.js';
import { AgentsService } from '../src/agents/agents.service.js';
import { AgentPreviewService } from '../src/bot/agent-preview.service.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WHATSAPP_CLIENT_FACTORY } from '../src/whatsapp/whatsapp.client.js';
import { fixedClientFactory } from './fixtures/client-factory.js';

// HTTP contract of the admin API (guard and validation). Behavior against a
// real database is covered in test/int/admin.int-spec.ts.
// Must match the dummy env in vitest.config.e2e.ts.
const ADMIN_KEY = 'e2e-admin-api-key-0123456789abcdef';
const CONVERSATION_ID = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

describe('Admin API (e2e)', () => {
  const admin = {
    listLeads: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    sendHumanReply: vi.fn(),
  };
  const businesses = { createBusiness: vi.fn(), createLine: vi.fn() };
  const agents = { get: vi.fn(), put: vi.fn() };
  const preview = { run: vi.fn() };
  let app: INestApplication<App>;

  beforeEach(async () => {
    for (const fn of [
      ...Object.values(admin),
      ...Object.values(businesses),
      ...Object.values(agents),
      ...Object.values(preview),
    ]) {
      fn.mockReset();
    }
    admin.listLeads.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText: vi.fn() }))
      .overrideProvider(AdminService)
      .useValue(admin)
      .overrideProvider(BusinessesService)
      .useValue(businesses)
      .overrideProvider(AgentsService)
      .useValue(agents)
      .overrideProvider(AgentPreviewService)
      .useValue(preview)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('API key guard', () => {
    it('returns 401 without a key', async () => {
      await http().get('/admin/leads').expect(401);
      expect(admin.listLeads).not.toHaveBeenCalled();
    });

    it.each([
      ['a wrong header key', { 'X-Admin-Api-Key': 'wrong' }],
      ['a key prefix', { 'X-Admin-Api-Key': ADMIN_KEY.slice(0, -1) }],
      ['a wrong bearer key', { Authorization: 'Bearer wrong' }],
      ['a non-bearer scheme', { Authorization: `Basic ${ADMIN_KEY}` }],
    ])('returns 401 for %s', async (_label, headers) => {
      const res = await http().get('/admin/leads').set(headers).expect(401);
      expect(JSON.stringify(res.body)).not.toContain(ADMIN_KEY);
      expect(admin.listLeads).not.toHaveBeenCalled();
    });

    it.each([
      ['the X-Admin-Api-Key header', { 'X-Admin-Api-Key': ADMIN_KEY }],
      ['a Bearer token', { Authorization: `Bearer ${ADMIN_KEY}` }],
    ])('accepts %s', async (_label, headers) => {
      await http().get('/admin/leads').set(headers).expect(200, []);
      expect(admin.listLeads).toHaveBeenCalledWith({ limit: 50 });
    });

    it('protects write routes too', async () => {
      await http()
        .post(`/admin/conversations/${CONVERSATION_ID}/pause`)
        .expect(401);
      expect(admin.pause).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    const authed = (req: request.Test) => req.set('X-Admin-Api-Key', ADMIN_KEY);

    it.each([
      ['an unknown lead status', '/admin/leads?status=BOGUS'],
      ['a limit over the max', '/admin/leads?limit=500'],
      ['a non-uuid conversation id', '/admin/conversations/abc'],
      ['a non-numeric wa id', '/admin/conversations/by-wa/abc'],
    ])('returns 400 for %s', async (_label, path) => {
      await authed(http().get(path)).expect(400);
    });

    it('returns 400 for an empty human reply', async () => {
      await authed(
        http()
          .post(`/admin/conversations/${CONVERSATION_ID}/messages`)
          .send({ text: '   ' }),
      ).expect(400);
      expect(admin.sendHumanReply).not.toHaveBeenCalled();
    });

    it('resolves handoffs on resume by default (no body)', async () => {
      admin.resume.mockResolvedValue({ paused: false });
      await authed(
        http().post(`/admin/conversations/${CONVERSATION_ID}/resume`),
      ).expect(200);
      expect(admin.resume).toHaveBeenCalledWith(CONVERSATION_ID, true);
    });

    it('maps reply outcomes to HTTP statuses', async () => {
      const send = () =>
        authed(
          http()
            .post(`/admin/conversations/${CONVERSATION_ID}/messages`)
            .set('Idempotency-Key', 'reply-1')
            .send({ text: 'Hola, soy Damián' }),
        );
      admin.sendHumanReply.mockResolvedValueOnce({ outcome: 'rejected' });
      await send().expect(502);
      admin.sendHumanReply.mockResolvedValueOnce({ outcome: 'uncertain' });
      await send().expect(202);
      admin.sendHumanReply.mockResolvedValueOnce({ outcome: 'sent' });
      await send().expect(200);
      expect(admin.sendHumanReply).toHaveBeenLastCalledWith(
        CONVERSATION_ID,
        'Hola, soy Damián',
        'reply-1',
      );
    });
  });

  describe('agent profile', () => {
    const BUSINESS_ID = '0b9f6c1e-9d2a-4f3b-8c4d-2a1b3c4d5e6f';
    const auth = { 'X-Admin-Api-Key': ADMIN_KEY };
    const body = {
      enabled: true,
      botName: 'Lola, IA de Peluquería Lola',
      persona: 'Simpática.',
      businessInfo: 'Brushing: $9.000',
      faq: [],
      leadFields: [
        { key: 'name', label: 'Nombre', required: true, kind: 'text' },
      ],
      handoffRules: '',
      outOfHoursMessage: null,
      model: null,
      demoEnabled: false,
    };
    const path = `/admin/businesses/${BUSINESS_ID}/agent`;

    it('requires the admin key on every agent route', async () => {
      await http().get(path).expect(401);
      await http().put(path).send(body).expect(401);
      await http()
        .post(`${path}/preview`)
        .send({ messages: [{ role: 'user', content: 'hola' }] })
        .expect(401);

      expect(agents.get).not.toHaveBeenCalled();
      expect(agents.put).not.toHaveBeenCalled();
      expect(preview.run).not.toHaveBeenCalled();
    });

    it('gets and puts the profile', async () => {
      agents.get.mockResolvedValue({ version: 1 });
      agents.put.mockResolvedValue({ version: 2 });

      await http().get(path).set(auth).expect(200, { version: 1 });
      await http().put(path).set(auth).send(body).expect(200, { version: 2 });

      expect(agents.get).toHaveBeenCalledWith(BUSINESS_ID);
      // openingHours is optional and defaults to null (no out-of-hours notice).
      expect(agents.put).toHaveBeenCalledWith(BUSINESS_ID, {
        ...body,
        openingHours: null,
      });
    });

    it.each([
      [
        'persona over 1.000 characters',
        { ...body, persona: 'a'.repeat(1_001) },
      ],
      [
        'a lead field key not in snake_case',
        {
          ...body,
          leadFields: [
            { key: 'Name', label: 'X', required: true, kind: 'text' },
          ],
        },
      ],
      ['an unknown field', { ...body, systemPrompt: 'x' }],
      ['a missing field', { ...body, demoEnabled: undefined }],
    ])('put returns 400 for %s', async (_label, invalid) => {
      await http().put(path).set(auth).send(invalid).expect(400);

      expect(agents.put).not.toHaveBeenCalled();
    });

    it('returns 400 for a business id that is not a uuid', async () => {
      await http().get('/admin/businesses/abc/agent').set(auth).expect(400);

      expect(agents.get).not.toHaveBeenCalled();
    });

    it('previews a turn', async () => {
      preview.run.mockResolvedValue({ reply: 'Hola' });
      const messages = [
        { role: 'assistant', content: '¿Cómo te llamás?' },
        { role: 'user', content: 'Ana' },
      ];

      await http()
        .post(`${path}/preview`)
        .set(auth)
        .send({ messages })
        .expect(200, { reply: 'Hola' });

      expect(preview.run).toHaveBeenCalledWith(BUSINESS_ID, messages);
    });

    it.each([
      ['no messages', { messages: [] }],
      [
        'a last message from the assistant',
        {
          messages: [{ role: 'assistant', content: 'Hola' }],
        },
      ],
      ['an unknown role', { messages: [{ role: 'system', content: 'x' }] }],
      ['an empty message', { messages: [{ role: 'user', content: '  ' }] }],
      [
        'a message over 1.000 characters',
        { messages: [{ role: 'user', content: 'a'.repeat(1_001) }] },
      ],
      [
        'more than 20 messages',
        {
          messages: Array.from({ length: 21 }, () => ({
            role: 'user',
            content: 'hola',
          })),
        },
      ],
    ])('preview returns 400 for %s', async (_label, invalid) => {
      await http().post(`${path}/preview`).set(auth).send(invalid).expect(400);

      expect(preview.run).not.toHaveBeenCalled();
    });
  });

  describe('businesses and lines', () => {
    const BUSINESS_ID = '0b9f6c1e-9d2a-4f3b-8c4d-2a1b3c4d5e6f';
    const lineBody = {
      phoneNumberId: '700000000000001',
      wabaId: '800000000000001',
      appId: '900000000000001',
      appSecret: 'client-app-secret-value',
      accessToken: 'EAAG-client-system-user-token-value',
    };
    const auth = { 'X-Admin-Api-Key': ADMIN_KEY };

    it('requires the admin key', async () => {
      await http()
        .post('/admin/businesses')
        .send({ name: 'A', slug: 'a', botName: 'A' })
        .expect(401);
      await http()
        .post(`/admin/businesses/${BUSINESS_ID}/lines`)
        .send(lineBody)
        .expect(401);

      expect(businesses.createBusiness).not.toHaveBeenCalled();
      expect(businesses.createLine).not.toHaveBeenCalled();
    });

    it('creates a business with 201', async () => {
      businesses.createBusiness.mockResolvedValue({ id: BUSINESS_ID });

      await http()
        .post('/admin/businesses')
        .set(auth)
        .send({
          name: 'Peluquería Ana',
          slug: 'peluqueria-ana',
          botName: 'Ana',
        })
        .expect(201, { id: BUSINESS_ID });

      expect(businesses.createBusiness).toHaveBeenCalledWith({
        name: 'Peluquería Ana',
        slug: 'peluqueria-ana',
        botName: 'Ana',
      });
    });

    it.each([
      ['a slug with spaces', { name: 'A', slug: 'mi negocio', botName: 'A' }],
      ['a missing botName', { name: 'A', slug: 'a' }],
      ['an unknown field', { name: 'A', slug: 'a', botName: 'A', extra: 1 }],
    ])('returns 400 for %s', async (_label, body) => {
      await http().post('/admin/businesses').set(auth).send(body).expect(400);

      expect(businesses.createBusiness).not.toHaveBeenCalled();
    });

    it('creates a line with 201', async () => {
      businesses.createLine.mockResolvedValue({ webhookPath: '/x' });

      await http()
        .post(`/admin/businesses/${BUSINESS_ID}/lines`)
        .set(auth)
        .send(lineBody)
        .expect(201, { webhookPath: '/x' });

      expect(businesses.createLine).toHaveBeenCalledWith(BUSINESS_ID, lineBody);
    });

    it.each([
      ['a non-numeric phone number id', { ...lineBody, phoneNumberId: 'abc' }],
      ['a missing app secret', { ...lineBody, appSecret: undefined }],
      ['a too short access token', { ...lineBody, accessToken: 'short' }],
    ])('returns 400 for %s', async (_label, body) => {
      await http()
        .post(`/admin/businesses/${BUSINESS_ID}/lines`)
        .set(auth)
        .send(body)
        .expect(400);

      expect(businesses.createLine).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid business id', async () => {
      await http()
        .post('/admin/businesses/not-a-uuid/lines')
        .set(auth)
        .send(lineBody)
        .expect(400);
    });

    it('never echoes secrets in a validation error', async () => {
      const res = await http()
        .post(`/admin/businesses/${BUSINESS_ID}/lines`)
        .set(auth)
        .send({ ...lineBody, phoneNumberId: 'abc' })
        .expect(400);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(lineBody.appSecret);
      expect(raw).not.toContain(lineBody.accessToken);
    });
  });
});
