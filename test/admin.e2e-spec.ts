import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AdminService } from '../src/admin/admin.service.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WHATSAPP_CLIENT } from '../src/whatsapp/whatsapp.client.js';

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
  let app: INestApplication<App>;

  beforeEach(async () => {
    for (const fn of Object.values(admin)) {
      fn.mockReset();
    }
    admin.listLeads.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WHATSAPP_CLIENT)
      .useValue({ sendText: vi.fn() })
      .overrideProvider(AdminService)
      .useValue(admin)
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
});
