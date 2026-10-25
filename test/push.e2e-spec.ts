import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { type Env, parseEnv } from '../src/config/env.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PushSubscriptionsService } from '../src/push/push-subscriptions.service.js';
import { WHATSAPP_CLIENT_FACTORY } from '../src/whatsapp/whatsapp.client.js';
import { fixedClientFactory } from './fixtures/client-factory.js';

// HTTP contract of the push routes (session, validation, push on or off).
// The rows themselves are covered in test/int/push.int-spec.ts.
const VAPID = {
  // A throwaway pair, generated for these tests only.
  VAPID_PUBLIC_KEY:
    'BDWoHXwGd0A1EkmJifVYTn-LkoWyr7Vg38nBPQlPawo4WhgQY8qkSbl_mzslt4X7XlJpbO1EnPw6JVUsl7KRfdY',
  VAPID_PRIVATE_KEY: 'yPmYWYTyNgsNmDJWJwKd6DeTQ5JuM_IO5W7XSc9PYXw',
  VAPID_SUBJECT: 'mailto:hola@botsuite46.com',
};
const USER = {
  id: '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
  email: 'ana@example.com',
  name: 'Ana',
  mustChangePassword: false,
};
const SESSION = 'bottega_session=valid';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const KEYS = {
  p256dh:
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};

describe('Push routes (e2e)', () => {
  const subscriptions = { save: vi.fn(), remove: vi.fn() };
  let app: INestApplication<App>;

  const start = async (env: Partial<Env>) => {
    const parsed = parseEnv({ ...process.env, ...env });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText: vi.fn() }))
      .overrideProvider(AppConfigService)
      .useValue({ get: (key: keyof Env) => parsed[key] })
      .overrideProvider(AuthService)
      .useValue({
        userForSession: (token: string | undefined) =>
          Promise.resolve(token === 'valid' ? USER : null),
      })
      .overrideProvider(PushSubscriptionsService)
      .useValue(subscriptions)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
  };

  beforeEach(() => {
    subscriptions.save.mockReset().mockResolvedValue(undefined);
    subscriptions.remove.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('with push configured', () => {
    beforeEach(() => start(VAPID));

    it('every route needs a session (401)', async () => {
      await http().get('/inbox/push/public-key').expect(401);
      await http()
        .post('/inbox/push/subscriptions')
        .send({ endpoint: ENDPOINT, keys: KEYS })
        .expect(401);
      await http()
        .delete('/inbox/push/subscriptions')
        .send({ endpoint: ENDPOINT })
        .expect(401);
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(subscriptions.remove).not.toHaveBeenCalled();
    });

    it('gives the VAPID public key', async () => {
      const res = await http()
        .get('/inbox/push/public-key')
        .set('Cookie', SESSION)
        .expect(200);

      expect(res.body).toEqual({ publicKey: VAPID.VAPID_PUBLIC_KEY });
    });

    it('saves the subscription for the session user (201), with the browser', async () => {
      await http()
        .post('/inbox/push/subscriptions')
        .set('Cookie', SESSION)
        .set('User-Agent', 'Mozilla/5.0 (Android)')
        .send({ endpoint: ENDPOINT, keys: KEYS })
        .expect(201);

      expect(subscriptions.save).toHaveBeenCalledWith(USER.id, {
        endpoint: ENDPOINT,
        keys: KEYS,
        userAgent: 'Mozilla/5.0 (Android)',
      });
    });

    it.each([
      [
        'an http endpoint',
        { endpoint: 'http://push.example.com/x', keys: KEYS },
        'body.endpoint',
      ],
      ['no keys', { endpoint: ENDPOINT }, 'body.keys'],
      [
        'a key that is not base64url',
        { endpoint: ENDPOINT, keys: { ...KEYS, auth: 'a b' } },
        'body.keys.auth',
      ],
      [
        'an unknown field',
        { endpoint: ENDPOINT, keys: KEYS, extra: 1 },
        'body',
      ],
    ])('rejects %s with 400', async (_label, body, path) => {
      const res = await http()
        .post('/inbox/push/subscriptions')
        .set('Cookie', SESSION)
        .send(body)
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(path);
      expect(subscriptions.save).not.toHaveBeenCalled();
    });

    it('deletes the subscription of the session user (204)', async () => {
      await http()
        .delete('/inbox/push/subscriptions')
        .set('Cookie', SESSION)
        .send({ endpoint: ENDPOINT })
        .expect(204);

      expect(subscriptions.remove).toHaveBeenCalledWith(USER.id, ENDPOINT);
    });

    it('rejects a delete without an https endpoint (400)', async () => {
      await http()
        .delete('/inbox/push/subscriptions')
        .set('Cookie', SESSION)
        .send({})
        .expect(400);
      expect(subscriptions.remove).not.toHaveBeenCalled();
    });
  });

  describe('without push configured', () => {
    beforeEach(() => start({}));

    it('answers 404 on every route', async () => {
      await http()
        .get('/inbox/push/public-key')
        .set('Cookie', SESSION)
        .expect(404);
      await http()
        .post('/inbox/push/subscriptions')
        .set('Cookie', SESSION)
        .send({ endpoint: ENDPOINT, keys: KEYS })
        .expect(404);
      await http()
        .delete('/inbox/push/subscriptions')
        .set('Cookie', SESSION)
        .send({ endpoint: ENDPOINT })
        .expect(404);
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(subscriptions.remove).not.toHaveBeenCalled();
    });
  });
});
