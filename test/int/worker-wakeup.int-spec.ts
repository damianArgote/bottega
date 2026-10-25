import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';
import { AppModule } from '../../src/app.module.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  type SendOutcome,
  WHATSAPP_CLIENT_FACTORY,
} from '../../src/whatsapp/whatsapp.client.js';
import { resetDb, testConfig } from './helpers.js';

// Must match the env in vitest.config.int.ts.
const APP_SECRET = 'int-meta-app-secret';
const PHONE_NUMBER_ID = '000000000000000';
const USER = '5491100001234';

const sign = (raw: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

const textWebhook = (id: string, body: string) =>
  JSON.stringify({
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
                phone_number_id: PHONE_NUMBER_ID,
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

describe('Idle worker wake-up (integration)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue(
        testConfig({
          // The real background worker, idle for 10 minutes between polls.
          // The busy pace is also longer than 2 s, so only the in-process
          // wake-up can make the job run in time.
          WORKER_ENABLED: true,
          QUEUE_POLL_INTERVAL_MS: 5_000,
          QUEUE_IDLE_POLL_INTERVAL_MS: 600_000,
        }),
      )
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText }))
      .compile();
    prisma = moduleRef.get(PrismaService);
    await resetDb(prisma);
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('processes an enqueued job in under 2 s without waiting the idle interval', async () => {
    sendText.mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out' });
    // Let the first round find an empty queue and go to its idle sleep.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const raw = textWebhook('wamid.in.wake', 'hola');

    const startedAt = Date.now();
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw)
      .expect(200);

    await vi.waitFor(
      async () => {
        const job = await prisma.processingJob.findFirstOrThrow();
        expect(job.status).toBe('COMPLETED');
      },
      { timeout: 2_000, interval: 20 },
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(sendText).toHaveBeenCalledExactlyOnceWith(
      USER,
      'Hola! Soy BotSuite46 🤖 Recibí tu mensaje: "hola"',
    );
  });
});
