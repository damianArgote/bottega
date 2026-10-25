import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { WebhookReprocessor } from '../../src/whatsapp/webhook-reprocessor.js';
import {
  type SendOutcome,
  WHATSAPP_CLIENT_FACTORY,
} from '../../src/whatsapp/whatsapp.client.js';
import { DEFAULT_PHONE_NUMBER_ID, createLine, resetDb } from './helpers.js';

// Must match META_APP_SECRET in vitest.config.int.ts (keyless default route).
const ENV_APP_SECRET = 'int-meta-app-secret';
const USER = '5491100001234';

const sign = (raw: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

function textWebhook(phoneNumberId: string, id: string, body = 'hola') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550001111',
                phone_number_id: phoneNumberId,
              },
              contacts: [{ wa_id: USER, profile: { name: 'Ana' } }],
              messages: [
                {
                  from: USER,
                  id,
                  timestamp: '1760140800',
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('Per-line webhooks and webhook events (integration)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reprocessor: WebhookReprocessor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText }))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    reprocessor = app.get(WebhookReprocessor);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  const post = (path: string, raw: string, secret: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw, secret))
      .send(raw);

  describe('POST /webhooks/whatsapp/:webhookKey', () => {
    it("rejects a signature made with another line's secret (401) and stores nothing", async () => {
      const a = await createLine(prisma, {
        slug: 'a',
        phoneNumberId: '111',
        appSecret: 'secret-a',
      });
      await createLine(prisma, {
        slug: 'b',
        phoneNumberId: '222',
        appSecret: 'secret-b',
      });
      const raw = textWebhook('111', 'wamid.1');

      await post(`/webhooks/whatsapp/${a.webhookKey}`, raw, 'secret-b').expect(
        401,
      );

      expect(await prisma.webhookEvent.count()).toBe(0);
      expect(await prisma.message.count()).toBe(0);
    });

    it('answers 404 to an unknown webhook key and stores nothing', async () => {
      const raw = textWebhook('111', 'wamid.1');

      await post(
        '/webhooks/whatsapp/unknown-key-0000000000000',
        raw,
        'x',
      ).expect(404);

      expect(await prisma.webhookEvent.count()).toBe(0);
    });

    it('keeps the same wa_id on two businesses as two contacts and two conversations', async () => {
      const a = await createLine(prisma, {
        slug: 'a',
        phoneNumberId: '111',
        appSecret: 'secret-a',
      });
      const b = await createLine(prisma, {
        slug: 'b',
        phoneNumberId: '222',
        appSecret: 'secret-b',
      });

      await post(
        `/webhooks/whatsapp/${a.webhookKey}`,
        textWebhook('111', 'wamid.a'),
        'secret-a',
      ).expect(200, 'EVENT_RECEIVED');
      await post(
        `/webhooks/whatsapp/${b.webhookKey}`,
        textWebhook('222', 'wamid.b'),
        'secret-b',
      ).expect(200);

      const contacts = await prisma.contact.findMany({ where: { waId: USER } });
      expect(new Set(contacts.map((c) => c.businessId))).toEqual(
        new Set([a.businessId, b.businessId]),
      );
      const threads = await prisma.conversation.findMany();
      expect(new Set(threads.map((t) => t.lineId))).toEqual(
        new Set([a.lineId, b.lineId]),
      );
      expect(await prisma.message.count()).toBe(2);
    });

    it('stores one message when the same payload arrives twice', async () => {
      const a = await createLine(prisma, {
        slug: 'a',
        phoneNumberId: '111',
        appSecret: 'secret-a',
      });
      const raw = textWebhook('111', 'wamid.same');

      await post(`/webhooks/whatsapp/${a.webhookKey}`, raw, 'secret-a').expect(
        200,
      );
      await post(`/webhooks/whatsapp/${a.webhookKey}`, raw, 'secret-a').expect(
        200,
      );

      expect(await prisma.message.count()).toBe(1);
      expect(await prisma.processingJob.count()).toBe(1);
      expect(await prisma.webhookEvent.count()).toBe(2);
      expect(
        await prisma.webhookEvent.count({ where: { processedAt: null } }),
      ).toBe(0);
    });

    it("discards events for another line's phone number id", async () => {
      const a = await createLine(prisma, {
        slug: 'a',
        phoneNumberId: '111',
        appSecret: 'secret-a',
      });
      await createLine(prisma, { slug: 'b', phoneNumberId: '222' });

      await post(
        `/webhooks/whatsapp/${a.webhookKey}`,
        textWebhook('222', 'wamid.cross'),
        'secret-a',
      ).expect(200);

      expect(await prisma.message.count()).toBe(0);
      expect(await prisma.conversation.count()).toBe(0);
      expect(await prisma.contact.count()).toBe(0);
      // Discarding is a final outcome: nothing to retry.
      expect(
        await prisma.webhookEvent.count({ where: { processedAt: null } }),
      ).toBe(0);
    });

    it('creates nothing for an unknown phone number id', async () => {
      const a = await createLine(prisma, {
        slug: 'a',
        phoneNumberId: '111',
        appSecret: 'secret-a',
      });

      await post(
        `/webhooks/whatsapp/${a.webhookKey}`,
        textWebhook('999', 'wamid.unknown'),
        'secret-a',
      ).expect(200);

      expect(await prisma.message.count()).toBe(0);
      expect(await prisma.contact.count()).toBe(0);
      expect(await prisma.conversation.count()).toBe(0);
    });
  });

  describe('GET /webhooks/whatsapp/:webhookKey', () => {
    const verify = (key: string, token: string) =>
      request(app.getHttpServer()).get(`/webhooks/whatsapp/${key}`).query({
        'hub.mode': 'subscribe',
        'hub.verify_token': token,
        'hub.challenge': '42',
      });

    it("echoes the challenge with the line's verify token", async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });

      await verify(a.webhookKey, a.verifyToken).expect(200, '42');
    });

    it("rejects another line's verify token (403)", async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });
      const b = await createLine(prisma, { slug: 'b', phoneNumberId: '222' });

      await verify(a.webhookKey, b.verifyToken).expect(403);
    });

    it('answers 404 to an unknown webhook key', async () => {
      await verify('unknown-key-0000000000000', 'x').expect(404);
    });
  });

  describe('reprocessing', () => {
    it('keeps a failed processing pending and the reprocessor finishes it', async () => {
      // No default line yet (e.g. the seed has not run): processing fails.
      await prisma.line.deleteMany();
      await prisma.business.deleteMany();
      const raw = textWebhook(DEFAULT_PHONE_NUMBER_ID, 'wamid.late');

      await post('/webhooks/whatsapp', raw, ENV_APP_SECRET).expect(200);

      const pending = await prisma.webhookEvent.findFirstOrThrow();
      expect(pending).toMatchObject({ processedAt: null, attempts: 1 });
      expect(pending.error).toBeTruthy();
      expect(await prisma.message.count()).toBe(0);

      await createLine(prisma, {
        slug: 'botsuite46',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
      });
      const result = await reprocessor.runOnce();

      expect(result).toMatchObject({ processed: 1, failed: 0 });
      const done = await prisma.webhookEvent.findFirstOrThrow();
      expect(done.processedAt).not.toBeNull();
      expect(done.error).toBeNull();
      expect(await prisma.message.count()).toBe(1);
    });

    it('leaves processed events alone', async () => {
      const a = await createLine(prisma, {
        slug: 'a',
        phoneNumberId: '111',
        appSecret: 'secret-a',
      });
      await post(
        `/webhooks/whatsapp/${a.webhookKey}`,
        textWebhook('111', 'wamid.1'),
        'secret-a',
      ).expect(200);

      expect(await reprocessor.runOnce()).toMatchObject({
        processed: 0,
        failed: 0,
      });
    });
  });

  describe('POST /webhooks/whatsapp (default line)', () => {
    it('still routes signed deliveries to the default line', async () => {
      await post(
        '/webhooks/whatsapp',
        textWebhook(DEFAULT_PHONE_NUMBER_ID, 'wamid.default'),
        ENV_APP_SECRET,
      ).expect(200, 'EVENT_RECEIVED');

      const thread = await prisma.conversation.findFirstOrThrow({
        include: { line: true },
      });
      expect(thread.line?.phoneNumberId).toBe(DEFAULT_PHONE_NUMBER_ID);
    });
  });
});
