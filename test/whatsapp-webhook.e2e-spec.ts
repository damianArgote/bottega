import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { InboundDispatcher } from '../src/whatsapp/inbound.dispatcher.js';
import {
  type SendOutcome,
  WHATSAPP_CLIENT,
} from '../src/whatsapp/whatsapp.client.js';

// Must match the dummy env in vitest.config.e2e.ts.
const APP_SECRET = 'e2e-meta-app-secret';
const VERIFY_TOKEN = 'e2e-verify-token';
const PHONE_NUMBER_ID = '000000000000000';
const USER = '5491100001234';
const PATH = '/webhooks/whatsapp';

const sign = (raw: string | Buffer) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

function messagePayload(
  message: Record<string, unknown>,
  phoneNumberId = PHONE_NUMBER_ID,
): string {
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
              messages: [{ from: USER, timestamp: '1760140800', ...message }],
            },
          },
        ],
      },
    ],
  });
}

const textMessage = (id: string, body: string) =>
  messagePayload({ id, type: 'text', text: { body } });

describe('WhatsApp webhook (e2e)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  let app: INestApplication<App>;
  let dispatcher: InboundDispatcher;

  beforeEach(async () => {
    sendText.mockReset();
    sendText.mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WHATSAPP_CLIENT)
      .useValue({ sendText })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    dispatcher = app.get(InboundDispatcher);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (raw: string, signature: string | null = sign(raw)) => {
    const req = request(app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json');
    if (signature !== null) {
      req.set('X-Hub-Signature-256', signature);
    }
    return req.send(raw);
  };

  describe('GET verification', () => {
    it('returns the challenge as plain text for a valid request', async () => {
      const res = await request(app.getHttpServer())
        .get(PATH)
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        })
        .expect(200);

      expect(res.text).toBe('1158201444');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    });

    it.each([
      [
        'a wrong token',
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong',
          'hub.challenge': '1',
        },
      ],
      [
        'a wrong mode',
        {
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1',
        },
      ],
      ['missing params', {}],
    ])('returns 403 for %s', async (_label, query) => {
      await request(app.getHttpServer()).get(PATH).query(query).expect(403);
    });
  });

  describe('POST events', () => {
    it('verifies the signature over the exact raw bytes and echoes text', async () => {
      const text = '¡Hola, señor! ¿Cómo andás? 🍕';
      // Unusual whitespace and escaped unicode: re-serializing the parsed body
      // would produce different bytes and break the signature.
      const raw = textMessage('wamid.in.1', text)
        .replace('{', '{\n  ')
        .replace('"field":', '"field" :  ')
        .replace('Ana', 'An\\u0061');

      const res = await post(raw).expect(200);
      await dispatcher.whenIdle();

      expect(res.text).toBe('EVENT_RECEIVED');
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        USER,
        `Hola! Soy Bottega 🤖 Recibí tu mensaje: "${text}"`,
      );
    });

    it.each([
      ['a wrong signature', sign('something else entirely')],
      ['a malformed header', 'sha256=not-hex'],
      ['a missing header', null],
    ])('returns 401 for %s and sends nothing', async (_label, signature) => {
      await post(textMessage('wamid.in.2', 'hola'), signature).expect(401);
      await dispatcher.whenIdle();

      expect(sendText).not.toHaveBeenCalled();
    });

    it('returns 401 for a signature valid for a different body', async () => {
      const signedBody = textMessage('wamid.in.3', 'hola');
      const tampered = textMessage('wamid.in.3', 'chau');

      await post(tampered, sign(signedBody)).expect(401);
      await dispatcher.whenIdle();

      expect(sendText).not.toHaveBeenCalled();
    });

    it('accepts a status-only payload without replying', async () => {
      const raw = JSON.stringify({
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
                  statuses: [
                    {
                      id: 'wamid.out',
                      status: 'delivered',
                      timestamp: '1760140800',
                      recipient_id: USER,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      await post(raw).expect(200);
      await dispatcher.whenIdle();

      expect(sendText).not.toHaveBeenCalled();
    });

    it('replies only once to a duplicated delivery', async () => {
      const raw = textMessage('wamid.dup', 'hola');

      await post(raw).expect(200);
      await post(raw).expect(200);
      await dispatcher.whenIdle();

      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it('answers unsupported message types with a text-only hint', async () => {
      const raw = messagePayload({
        id: 'wamid.img',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg' },
      });

      await post(raw).expect(200);
      await dispatcher.whenIdle();

      expect(sendText).toHaveBeenCalledWith(
        USER,
        'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribís?',
      );
    });

    it('ignores events for another phone number id', async () => {
      const raw = messagePayload(
        { id: 'wamid.other', type: 'text', text: { body: 'hola' } },
        '999999999999999',
      );

      await post(raw).expect(200);
      await dispatcher.whenIdle();

      expect(sendText).not.toHaveBeenCalled();
    });

    it('still answers 200 when sending fails', async () => {
      sendText.mockRejectedValue(new Error('unexpected'));

      await post(textMessage('wamid.fail', 'hola')).expect(200);
      await dispatcher.whenIdle();

      expect(sendText).toHaveBeenCalledTimes(1);
    });
  });
});
