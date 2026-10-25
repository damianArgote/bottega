import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { fixedClientFactory } from './fixtures/client-factory.js';
import { AppModule } from '../src/app.module.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { parseEnv } from '../src/config/env.schema.js';
import { LineCredentialsService } from '../src/lines/line-credentials.service.js';
import { LinesService, type WebhookLine } from '../src/lines/lines.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WebhookEventsService } from '../src/whatsapp/webhook-events.service.js';
import { WHATSAPP_CLIENT_FACTORY } from '../src/whatsapp/whatsapp.client.js';

// HTTP-level contract only (verification, signatures, status codes, what is
// handed to storage). Parsing, routing, persistence, dedupe, reprocessing and
// replies are covered against a real database in the integration suite
// (npm run test:int).
// Must match the dummy env in vitest.config.e2e.ts.
const APP_SECRET = 'e2e-meta-app-secret';
const VERIFY_TOKEN = 'e2e-verify-token';
const PHONE_NUMBER_ID = '000000000000000';
const USER = '5491100001234';
const PATH = '/webhooks/whatsapp';
const LINE_KEY = 'line-a-webhook-key-00000';
const LINE_APP_SECRET = 'line-a-app-secret';
const LINE_VERIFY_TOKEN = 'line-a-verify-token';

const sign = (raw: string | Buffer, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

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
  const receive =
    vi.fn<(payload: unknown, lineId: string | null) => Promise<void>>();
  const findByWebhookKey =
    vi.fn<(webhookKey: string) => Promise<WebhookLine | null>>();
  const sendText = vi.fn();
  let app: INestApplication<App>;
  let line: WebhookLine;

  beforeEach(async () => {
    receive.mockReset();
    receive.mockResolvedValue(undefined);
    findByWebhookKey.mockReset();
    sendText.mockReset();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WebhookEventsService)
      .useValue({ receive })
      .overrideProvider(LinesService)
      .useValue({ findByWebhookKey })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText }))
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
    line = {
      id: 'line-a',
      businessId: 'business-a',
      phoneNumberId: '111111111111111',
      active: true,
      verifyToken: LINE_VERIFY_TOKEN,
      appSecretEncrypted: app
        .get(LineCredentialsService)
        .encrypt(LINE_APP_SECRET),
    };
    findByWebhookKey.mockImplementation((key) =>
      Promise.resolve(key === LINE_KEY ? line : null),
    );
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
    it('verifies the signature over the exact raw bytes and persists before answering', async () => {
      const text = '¡Hola, señor! ¿Cómo andás? 🍕';
      // Unusual whitespace and escaped unicode: re-serializing the parsed body
      // would produce different bytes and break the signature.
      const raw = textMessage('wamid.in.1', text)
        .replace('{', '{\n  ')
        .replace('"field":', '"field" :  ')
        .replace('Ana', 'An\\u0061');

      const res = await post(raw).expect(200);

      expect(res.text).toBe('EVENT_RECEIVED');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      // The parsed payload is stored for the default line (lineId null).
      expect(receive).toHaveBeenCalledExactlyOnceWith(JSON.parse(raw), null);
      // Replies are sent by the queue worker, never inside the request.
      expect(sendText).not.toHaveBeenCalled();
    });

    it.each([
      ['a wrong signature', sign('something else entirely')],
      ['a malformed header', 'sha256=not-hex'],
      ['a missing header', null],
    ])('returns 401 for %s and persists nothing', async (_label, signature) => {
      await post(textMessage('wamid.in.2', 'hola'), signature).expect(401);

      expect(receive).not.toHaveBeenCalled();
    });

    it('returns 401 for a signature valid for a different body', async () => {
      const signedBody = textMessage('wamid.in.3', 'hola');
      const tampered = textMessage('wamid.in.3', 'chau');

      await post(tampered, sign(signedBody)).expect(401);

      expect(receive).not.toHaveBeenCalled();
    });

    it('stores deliveries for any phone number id (routing happens when processing)', async () => {
      const raw = messagePayload(
        { id: 'wamid.other', type: 'text', text: { body: 'hola' } },
        '999999999999999',
      );

      await post(raw).expect(200);

      expect(receive).toHaveBeenCalledExactlyOnceWith(JSON.parse(raw), null);
    });

    it('answers 500 when persistence fails so Meta redelivers', async () => {
      receive.mockRejectedValue(new Error('database unavailable'));

      const res = await post(textMessage('wamid.fail', 'hola')).expect(500);

      expect(res.text).not.toContain('database unavailable');
    });
  });

  describe('per-line route /webhooks/whatsapp/:webhookKey', () => {
    const postLine = (key: string, raw: string, signature: string | null) => {
      const req = request(app.getHttpServer())
        .post(`${PATH}/${key}`)
        .set('Content-Type', 'application/json');
      if (signature !== null) {
        req.set('X-Hub-Signature-256', signature);
      }
      return req.send(raw);
    };
    const verifyLine = (key: string, token: string) =>
      request(app.getHttpServer()).get(`${PATH}/${key}`).query({
        'hub.mode': 'subscribe',
        'hub.verify_token': token,
        'hub.challenge': '777',
      });

    it("stores a delivery signed with the line's app secret, for that line", async () => {
      const raw = textMessage('wamid.line', 'hola');

      const res = await postLine(
        LINE_KEY,
        raw,
        sign(raw, LINE_APP_SECRET),
      ).expect(200);

      expect(res.text).toBe('EVENT_RECEIVED');
      expect(receive).toHaveBeenCalledExactlyOnceWith(
        JSON.parse(raw),
        'line-a',
      );
    });

    it.each([
      ['the default app secret', (raw: string) => sign(raw)],
      ["another line's secret", (raw: string) => sign(raw, 'secret-b')],
      ['no signature', () => null],
    ])('returns 401 for %s and stores nothing', async (_label, signer) => {
      const raw = textMessage('wamid.line', 'hola');

      await postLine(LINE_KEY, raw, signer(raw)).expect(401);

      expect(receive).not.toHaveBeenCalled();
    });

    it('returns 401 when the line has no app secret', async () => {
      line.appSecretEncrypted = null;
      const raw = textMessage('wamid.line', 'hola');

      await postLine(LINE_KEY, raw, sign(raw, LINE_APP_SECRET)).expect(401);

      expect(receive).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown key', 'unknown-key-000000000000'],
      ['an inactive line', LINE_KEY],
    ])('returns 404 for %s and stores nothing', async (label, key) => {
      if (label === 'an inactive line') {
        line.active = false;
      }
      const raw = textMessage('wamid.line', 'hola');

      await postLine(key, raw, sign(raw, LINE_APP_SECRET)).expect(404);

      expect(receive).not.toHaveBeenCalled();
      expect(findByWebhookKey).toHaveBeenCalledExactlyOnceWith(key);
    });

    it("echoes the challenge with the line's verify token", async () => {
      const res = await verifyLine(LINE_KEY, LINE_VERIFY_TOKEN).expect(200);

      expect(res.text).toBe('777');
    });

    it('rejects the default verify token on a line route (403)', async () => {
      await verifyLine(LINE_KEY, VERIFY_TOKEN).expect(403);
    });

    it('returns 404 to the handshake of an unknown key', async () => {
      await verifyLine('unknown-key-000000000000', LINE_VERIFY_TOKEN).expect(
        404,
      );
    });
  });

  describe('keyless route without the default line variables', () => {
    let bare: INestApplication<App>;

    beforeEach(async () => {
      const env = parseEnv(process.env);
      const withoutMeta: Record<string, unknown> = {
        ...env,
        META_APP_SECRET: undefined,
        WHATSAPP_VERIFY_TOKEN: undefined,
        WHATSAPP_ACCESS_TOKEN: undefined,
        WHATSAPP_PHONE_NUMBER_ID: undefined,
      };
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AppConfigService)
        .useValue({ get: (key: string) => withoutMeta[key] })
        .overrideProvider(PrismaService)
        .useValue({})
        .overrideProvider(WebhookEventsService)
        .useValue({ receive })
        .overrideProvider(LinesService)
        .useValue({ findByWebhookKey })
        .compile();
      bare = moduleRef.createNestApplication({ rawBody: true, logger: false });
      await bare.init();
    });

    afterEach(async () => {
      await bare.close();
    });

    it('answers 404 to the handshake', async () => {
      await request(bare.getHttpServer())
        .get(PATH)
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1',
        })
        .expect(404);
    });

    it('answers 404 to deliveries and stores nothing', async () => {
      const raw = textMessage('wamid.none', 'hola');

      await request(bare.getHttpServer())
        .post(PATH)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(raw))
        .send(raw)
        .expect(404);

      expect(receive).not.toHaveBeenCalled();
    });
  });
});
