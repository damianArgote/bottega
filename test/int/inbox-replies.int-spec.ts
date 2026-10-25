import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import {
  InMemoryLoginRateLimiter,
  LOGIN_RATE_LIMITER,
} from '../../src/auth/login-rate-limiter.js';
import { UsersService } from '../../src/auth/users.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  WHATSAPP_CLIENT_FACTORY,
  type SendOutcome,
} from '../../src/whatsapp/whatsapp.client.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';
import { resetDb, textEvent } from './helpers.js';

const PASSWORD = 'una clave larga';
const USER = '5491100001234';
const HOUR = 60 * 60 * 1000;

describe('Inbox replies and read (integration, HTTP)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const markRead = vi.fn<(waMessageId: string) => Promise<boolean>>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
  let businessId: string;
  let ip = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: (keys: string[]) => limiter.attempt(keys) })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText, markRead }))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
    sendText.mockReset();
    sendText.mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out.1' });
    markRead.mockReset();
    markRead.mockResolvedValue(true);
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    for (const [email, name] of [
      ['ana@example.com', 'Ana'],
      ['beto@example.com', 'Beto'],
    ]) {
      await users.addToBusiness(businessId, {
        email: email!,
        name: name!,
        password: PASSWORD,
        role: 'AGENT',
      });
    }
  });

  const http = () => request(app.getHttpServer());
  const sessionOf = async (email: string) => {
    ip += 1;
    const res = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', `10.2.0.${ip}`)
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };
  const conversationId = async () => {
    await app.get(ConversationsService).recordInbound({
      ...textEvent('wamid.in.1', USER, 'hola'),
      timestamp: new Date(),
    });
    return (await prisma.conversation.findFirstOrThrow()).id;
  };
  const reply = (cookie: string, id: string, body: object) =>
    http()
      .post(`/inbox/businesses/${businessId}/conversations/${id}/messages`)
      .set('Cookie', cookie)
      .send(body);
  const clientId = '6f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

  describe('send', () => {
    it('sends, stores the message SENT, and replying to an unassigned conversation takes it', async () => {
      const id = await conversationId();
      const ana = await sessionOf('ana@example.com');

      const res = await reply(ana, id, {
        body: 'Hola, soy Ana',
        clientId,
      }).expect(200);

      expect(res.body).toMatchObject({
        outcome: 'sent',
        waMessageId: 'wamid.out.1',
      });
      expect(sendText).toHaveBeenCalledWith(USER, 'Hola, soy Ana');
      expect(
        await prisma.message.findFirstOrThrow({
          where: { author: 'HUMAN', type: 'TEXT' },
        }),
      ).toMatchObject({
        status: 'SENT',
        waMessageId: 'wamid.out.1',
        type: 'TEXT',
      });
      const conversation = await prisma.conversation.findFirstOrThrow({
        include: { assignedTo: true },
      });
      expect(conversation.assignedTo?.name).toBe('Ana');
      expect(conversation.lastMessagePreview).toBe('Hola, soy Ana');
      expect(
        (await prisma.message.findMany({ where: { type: 'SYSTEM' } })).map(
          (m) => m.content,
        ),
      ).toEqual(['Ana tomó la conversación']);
    });

    it('the same clientId never sends twice', async () => {
      const id = await conversationId();
      const ana = await sessionOf('ana@example.com');

      await reply(ana, id, { body: 'Hola', clientId }).expect(200);
      const again = await reply(ana, id, { body: 'Hola', clientId }).expect(
        200,
      );

      expect(again.body).toMatchObject({ outcome: 'replayed', status: 'SENT' });
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it('with the window closed: 409 WINDOW_CLOSED before calling Meta', async () => {
      const id = await conversationId();
      await prisma.conversation.update({
        where: { id },
        data: { windowExpiresAt: new Date(Date.now() - HOUR) },
      });
      const ana = await sessionOf('ana@example.com');

      const res = await reply(ana, id, { body: 'Hola', clientId }).expect(409);

      expect(res.body).toMatchObject({ code: 'WINDOW_CLOSED' });
      expect(sendText).not.toHaveBeenCalled();
      expect(
        await prisma.message.count({
          where: { author: 'HUMAN', type: 'TEXT' },
        }),
      ).toBe(0);
    });

    it('a conversation someone else has: 409 ALREADY_TAKEN, nothing sent', async () => {
      const id = await conversationId();
      const beto = await sessionOf('beto@example.com');
      await http()
        .post(`/inbox/businesses/${businessId}/conversations/${id}/take`)
        .set('Cookie', beto)
        .send({})
        .expect(200);
      const ana = await sessionOf('ana@example.com');

      const res = await reply(ana, id, { body: 'Hola', clientId }).expect(409);

      expect(res.body).toMatchObject({ code: 'ALREADY_TAKEN' });
      expect(sendText).not.toHaveBeenCalled();
    });

    it('Meta 131047 (window closed): 502, the message FAILED and the window moves to now', async () => {
      const id = await conversationId();
      sendText.mockResolvedValue({
        kind: 'rejected',
        code: 131047,
        httpStatus: 400,
        message: 'Re-engagement message',
        retryable: false,
      });
      const ana = await sessionOf('ana@example.com');
      const before = Date.now();

      const res = await reply(ana, id, { body: 'Hola', clientId }).expect(502);

      expect(res.body).toMatchObject({ outcome: 'rejected', code: '131047' });
      expect(
        await prisma.message.findFirstOrThrow({
          where: { author: 'HUMAN', type: 'TEXT' },
        }),
      ).toMatchObject({ status: 'FAILED', errorCode: '131047' });
      const { windowExpiresAt } = await prisma.conversation.findFirstOrThrow();
      expect(windowExpiresAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(windowExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('an uncertain send answers 202 and is not retried', async () => {
      const id = await conversationId();
      sendText.mockResolvedValue({ kind: 'uncertain', reason: 'http 500' });
      const ana = await sessionOf('ana@example.com');

      await reply(ana, id, { body: 'Hola', clientId }).expect(202);

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(
        await prisma.message.findFirstOrThrow({
          where: { author: 'HUMAN', type: 'TEXT' },
        }),
      ).toMatchObject({ status: 'UNCERTAIN' });
    });

    it('validates the body', async () => {
      const id = await conversationId();
      const ana = await sessionOf('ana@example.com');

      await reply(ana, id, { body: 'Hola' }).expect(400);
      await reply(ana, id, { body: 'Hola', clientId: 'abc' }).expect(400);
      await reply(ana, id, { body: '   ', clientId }).expect(400);
      expect(sendText).not.toHaveBeenCalled();
    });
  });

  describe('read', () => {
    const read = (cookie: string, id: string) =>
      http()
        .post(`/inbox/businesses/${businessId}/conversations/${id}/read`)
        .set('Cookie', cookie)
        .send();

    it('clears the unread count and marks the last inbound message read in WhatsApp', async () => {
      const id = await conversationId();
      await app.get(ConversationsService).recordInbound({
        ...textEvent('wamid.in.2', USER, 'otra'),
        timestamp: new Date(),
      });
      const ana = await sessionOf('ana@example.com');

      const res = await read(ana, id).expect(200);

      expect(res.body).toMatchObject({ unreadCount: 0 });
      expect((await prisma.conversation.findFirstOrThrow()).unreadCount).toBe(
        0,
      );
      expect(markRead).toHaveBeenCalledWith('wamid.in.2');
    });

    it('ignores a failure to mark it read in WhatsApp', async () => {
      const id = await conversationId();
      markRead.mockRejectedValue(new Error('boom'));
      const ana = await sessionOf('ana@example.com');

      await read(ana, id).expect(200);

      expect((await prisma.conversation.findFirstOrThrow()).unreadCount).toBe(
        0,
      );
    });
  });
});
