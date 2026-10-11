import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { BotWorker } from '../../src/bot/worker.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  type SendOutcome,
  WHATSAPP_CLIENT,
} from '../../src/whatsapp/whatsapp.client.js';
import { resetDb } from './helpers.js';

// Must match the env in vitest.config.int.ts.
const APP_SECRET = 'int-meta-app-secret';
const PHONE_NUMBER_ID = '000000000000000';
const USER = '5491100001234';

const sign = (raw: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

function webhook(value: Record<string, unknown>): string {
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
                phone_number_id: PHONE_NUMBER_ID,
              },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

const textWebhook = (id: string, body: string) =>
  webhook({
    contacts: [{ wa_id: USER, profile: { name: 'Ana' } }],
    messages: [
      { from: USER, id, timestamp: '1760140800', type: 'text', text: { body } },
    ],
  });

describe('Webhook → queue → worker flow (integration)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let worker: BotWorker;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT)
      .useValue({ sendText })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    worker = app.get(BotWorker);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    sendText.mockReset();
    sendText.mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out' });
  });

  const post = (raw: string) =>
    request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);

  it('persists before answering 200 and replies once to duplicated deliveries', async () => {
    const raw = textWebhook('wamid.in.1', 'hola');

    await post(raw).expect(200, 'EVENT_RECEIVED');
    // Persisted by the time Meta gets the 200; nothing sent yet.
    expect(await prisma.processingJob.count()).toBe(1);
    expect(sendText).not.toHaveBeenCalled();

    await Promise.all([post(raw).expect(200), post(raw).expect(200)]);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.processingJob.count()).toBe(1);

    expect(await worker.drain()).toBe(1);
    expect(sendText).toHaveBeenCalledExactlyOnceWith(
      USER,
      'Hola! Soy Bottega 🤖 Recibí tu mensaje: "hola"',
    );
  });

  it('applies delivery statuses without creating jobs or replies', async () => {
    await post(textWebhook('wamid.in.1', 'hola')).expect(200);
    await worker.drain();
    sendText.mockClear();

    await post(
      webhook({
        statuses: [
          {
            id: 'wamid.out',
            status: 'read',
            timestamp: '1760140900',
            recipient_id: USER,
          },
        ],
      }),
    ).expect(200);

    expect(await prisma.processingJob.count()).toBe(1);
    expect(await worker.drain()).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    const reply = await prisma.message.findUniqueOrThrow({
      where: { waMessageId: 'wamid.out' },
    });
    expect(reply.status).toBe('READ');
  });
});
