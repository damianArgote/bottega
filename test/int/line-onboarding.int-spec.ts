import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { GraphWhatsAppClient } from '../../src/whatsapp/graph-whatsapp.client.js';
import { resetDb, testConfig } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const BASE_URL = 'https://bottega.example.com';

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue(testConfig({ PUBLIC_BASE_URL: BASE_URL }))
      .overrideProvider(GraphWhatsAppClient)
      .useValue(
        new GraphWhatsAppClient(
          { apiVersion: 'v26.0', timeoutMs: 1_000 },
          fetchMock,
        ),
      )
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
  });

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
});
