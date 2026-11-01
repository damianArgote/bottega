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
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { TemplatesSyncScheduler } from '../../src/templates/templates-sync.scheduler.js';
import { GraphOnboardingClient } from '../../src/whatsapp/graph-onboarding.client.js';
import {
  WHATSAPP_CLIENT_FACTORY,
  type SendOutcome,
  type TemplateMessage,
} from '../../src/whatsapp/whatsapp.client.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';
import { createLine, resetDb, textEvent } from './helpers.js';

const PASSWORD = 'una clave larga';
const USER = '5491100001234';
const WABA = '111222333';
const DAY = 24 * 60 * 60 * 1000;

const reminder = {
  id: 'meta-1',
  name: 'recordatorio_turno',
  language: 'es_AR',
  category: 'UTILITY',
  status: 'APPROVED',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, tu turno es el {{2}}.' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirmo' },
        { type: 'QUICK_REPLY', text: 'Necesito cambiarlo' },
      ],
    },
  ],
};
const promo = {
  id: 'meta-2',
  name: 'promo',
  language: 'es_AR',
  category: 'MARKETING',
  status: 'PENDING',
  components: [{ type: 'BODY', text: '20% off' }],
};

interface SyncBody {
  accounts: Array<Record<string, unknown>>;
}
interface ListBody {
  syncError: string | null;
  templates: Array<{ wabaId: string }>;
}
interface ErrorBody {
  code: string;
  message: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Message templates (integration, HTTP)', () => {
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const sendTemplate =
    vi.fn<(to: string, template: TemplateMessage) => Promise<SendOutcome>>();
  const graphFetch = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let limiter = new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 });
  let businessId: string;
  let lineId: string;
  let ip = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue({ attempt: (keys: string[]) => limiter.attempt(keys) })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(fixedClientFactory({ sendText, sendTemplate }))
      .overrideProvider(GraphOnboardingClient)
      .useValue(
        new GraphOnboardingClient(
          { apiVersion: 'v26.0', timeoutMs: 1000 },
          graphFetch,
        ),
      )
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
    sendTemplate.mockReset();
    sendTemplate.mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.tpl' });
    graphFetch.mockReset();
    graphFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: [reminder, promo] })),
    );
    const business = await prisma.business.findUniqueOrThrow({
      where: { slug: 'botsuite46' },
      include: { lines: true },
    });
    businessId = business.id;
    lineId = business.lines[0]!.id;
    await prisma.line.update({
      where: { id: lineId },
      data: {
        wabaId: WABA,
        accessTokenEncrypted: app
          .get(LineCredentialsService)
          .encrypt('line-token'),
      },
    });
    await users.addToBusiness(businessId, {
      email: 'ana@example.com',
      name: 'Ana',
      password: PASSWORD,
      role: 'AGENT',
    });
  });

  const http = () => request(app.getHttpServer());
  const session = async () => {
    ip += 1;
    const res = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', `10.3.0.${ip}`)
      .send({ email: 'ana@example.com', password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };
  const sync = (cookie: string) =>
    http()
      .post(`/inbox/businesses/${businessId}/templates/sync`)
      .set('Cookie', cookie);
  /** A conversation whose window closed two days ago. */
  const closedConversation = async () => {
    await app.get(ConversationsService).recordInbound({
      ...textEvent('wamid.in.1', USER, 'hola'),
      timestamp: new Date(Date.now() - 2 * DAY),
    });
    return (await prisma.conversation.findFirstOrThrow()).id;
  };
  const templateId = (name: string) =>
    prisma.template
      .findFirstOrThrow({ where: { name } })
      .then((t: { id: string }) => t.id);
  const send = (cookie: string, conversationId: string, body: object) =>
    http()
      .post(
        `/inbox/businesses/${businessId}/conversations/${conversationId}/templates`,
      )
      .set('Cookie', cookie)
      .send(body);
  const clientId = '7a1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

  describe('sync', () => {
    it('stores every template of the line account, with the token, and lists them', async () => {
      const cookie = await session();

      const res = await sync(cookie).expect(200);

      expect((res.body as SyncBody).accounts).toEqual([
        { wabaId: WABA, synced: 2, deleted: 0, error: null },
      ]);
      const [url, init] = graphFetch.mock.calls[0]!;
      expect(url as string).toContain(`/${WABA}/message_templates?fields=`);
      expect(init?.headers).toEqual({ Authorization: 'Bearer line-token' });

      const list = await http()
        .get(`/inbox/businesses/${businessId}/templates?lineId=${lineId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect((list.body as ListBody).syncError).toBeNull();
      expect((list.body as ListBody).templates).toEqual([
        expect.objectContaining({
          name: 'promo',
          status: 'PENDING',
          sendable: false,
        }),
        expect.objectContaining({
          name: 'recordatorio_turno',
          category: 'UTILITY',
          sendable: true,
          body: 'Hola {{1}}, tu turno es el {{2}}.',
          buttons: ['Confirmo', 'Necesito cambiarlo'],
          variables: [
            expect.objectContaining({ key: 'body.1' }),
            expect.objectContaining({ key: 'body.2' }),
          ],
        }),
      ]);
    });

    it('updates changed templates and marks the missing ones deleted without deleting them', async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      graphFetch.mockImplementation(() =>
        Promise.resolve(
          jsonResponse(200, { data: [{ ...promo, status: 'APPROVED' }] }),
        ),
      );

      const res = await sync(cookie).expect(200);

      expect((res.body as SyncBody).accounts[0]).toMatchObject({
        synced: 1,
        deleted: 1,
      });
      const rows = await prisma.template.findMany({ orderBy: { name: 'asc' } });
      expect(rows.map((r) => [r.name, r.status, r.deletedAt !== null])).toEqual(
        [
          ['promo', 'APPROVED', false],
          ['recordatorio_turno', 'APPROVED', true],
        ],
      );

      // It comes back when Meta returns it again.
      graphFetch.mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { data: [reminder] })),
      );
      await sync(cookie).expect(200);
      expect(
        (
          await prisma.template.findFirstOrThrow({
            where: { name: 'recordatorio_turno' },
          })
        ).deletedAt,
      ).toBeNull();
    });

    it('keeps the rows and records the error when Meta fails', async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      graphFetch.mockImplementation(() =>
        Promise.resolve(
          jsonResponse(401, { error: { code: 190, message: 'expired' } }),
        ),
      );

      const res = await sync(cookie).expect(200);

      expect((res.body as SyncBody).accounts[0]).toMatchObject({
        error: 'meta_190',
      });
      expect(await prisma.template.count({ where: { deletedAt: null } })).toBe(
        2,
      );
      const business = await prisma.business.findUniqueOrThrow({
        where: { id: businessId },
      });
      expect(business.templatesSyncError).toBe('meta_190');
    });

    it('answers 409 NO_WHATSAPP_ACCOUNT when no line has an account', async () => {
      await prisma.line.update({
        where: { id: lineId },
        data: { wabaId: null },
      });
      const cookie = await session();

      const res = await sync(cookie).expect(409);

      expect((res.body as ErrorBody).code).toBe('NO_WHATSAPP_ACCOUNT');
      expect(graphFetch).not.toHaveBeenCalled();
    });

    it('never lists another business templates', async () => {
      const other = await createLine(prisma, {
        slug: 'otro',
        phoneNumberId: '999000',
      });
      await prisma.line.update({
        where: { id: other.lineId },
        data: {
          wabaId: '444',
          accessTokenEncrypted: app.get(LineCredentialsService).encrypt('t'),
        },
      });
      await app.get(TemplatesSyncScheduler).runDue();
      const cookie = await session();

      const list = await http()
        .get(`/inbox/businesses/${businessId}/templates`)
        .set('Cookie', cookie)
        .expect(200);
      expect((list.body as ListBody).templates).toHaveLength(2);
      expect(
        (list.body as ListBody).templates.every(
          (t: { wabaId: string }) => t.wabaId === WABA,
        ),
      ).toBe(true);
      await http()
        .get(`/inbox/businesses/${other.businessId}/templates`)
        .set('Cookie', cookie)
        .expect(403);
    });
  });

  describe('daily sync', () => {
    it('syncs each business with an account once and moves it a day ahead', async () => {
      const scheduler = app.get(TemplatesSyncScheduler);

      expect(await scheduler.runDue()).toBe(1);
      expect(await scheduler.runDue()).toBe(0);

      expect(await prisma.template.count()).toBe(2);
      const business = await prisma.business.findUniqueOrThrow({
        where: { id: businessId },
      });
      expect(business.templatesSyncNextAt!.getTime()).toBeGreaterThan(
        Date.now() + DAY - 60_000,
      );
      expect(await scheduler.nextDelay()).toBeGreaterThan(DAY - 60_000);
    });

    it('does nothing (and sets no timer) without accounts', async () => {
      await prisma.line.update({
        where: { id: lineId },
        data: { wabaId: null },
      });
      const scheduler = app.get(TemplatesSyncScheduler);

      expect(await scheduler.runDue()).toBe(0);
      expect(await scheduler.nextDelay()).toBeNull();
      expect(graphFetch).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('sends an approved template with the window closed and keeps the rendered text', async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      const conversationId = await closedConversation();

      const res = await send(cookie, conversationId, {
        templateId: await templateId('recordatorio_turno'),
        values: ['Ana', 'jueves 10:00'],
        clientId,
      }).expect(200);

      expect(res.body).toMatchObject({
        outcome: 'sent',
        waMessageId: 'wamid.tpl',
      });
      expect(sendTemplate).toHaveBeenCalledWith(USER, {
        name: 'recordatorio_turno',
        language: 'es_AR',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: 'jueves 10:00' },
            ],
          },
        ],
      });
      expect(sendText).not.toHaveBeenCalled();
      const message = await prisma.message.findFirstOrThrow({
        where: { author: 'HUMAN', type: 'TEXT' },
      });
      expect(message).toMatchObject({
        status: 'SENT',
        waMessageId: 'wamid.tpl',
        content: 'Hola Ana, tu turno es el jueves 10:00.',
        buttons: [
          { id: 'template_0', title: 'Confirmo' },
          { id: 'template_1', title: 'Necesito cambiarlo' },
        ],
      });
      // Sending takes the conversation, like a reply.
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      expect(conversation.assignedToId).not.toBeNull();
      expect(conversation.lastMessagePreview).toBe(
        'Hola Ana, tu turno es el jueves 10:00.',
      );
    });

    it('never sends twice for the same clientId', async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      const conversationId = await closedConversation();
      const body = {
        templateId: await templateId('recordatorio_turno'),
        values: ['Ana', 'jueves'],
        clientId,
      };

      await send(cookie, conversationId, body).expect(200);
      const again = await send(cookie, conversationId, body).expect(200);

      expect(again.body).toMatchObject({ outcome: 'replayed', status: 'SENT' });
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    it('answers 400 TEMPLATE_VALUES naming the missing values, without calling Meta', async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      const conversationId = await closedConversation();

      const res = await send(cookie, conversationId, {
        templateId: await templateId('recordatorio_turno'),
        values: ['Ana'],
        clientId,
      }).expect(400);

      expect(res.body).toMatchObject({
        code: 'TEMPLATE_VALUES',
        missing: ['body.2'],
      });
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await prisma.message.count({ where: { author: 'HUMAN' } })).toBe(
        0,
      );
    });

    it('answers 409 for a template that is not approved or was deleted', async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      const conversationId = await closedConversation();

      const pending = await send(cookie, conversationId, {
        templateId: await templateId('promo'),
        values: [],
        clientId,
      }).expect(409);
      expect((pending.body as ErrorBody).code).toBe('TEMPLATE_NOT_APPROVED');

      await prisma.template.updateMany({
        where: { name: 'recordatorio_turno' },
        data: { deletedAt: new Date() },
      });
      const deleted = await send(cookie, conversationId, {
        templateId: await templateId('recordatorio_turno'),
        values: ['Ana', 'jueves'],
        clientId,
      }).expect(409);
      expect((deleted.body as ErrorBody).code).toBe('TEMPLATE_NOT_APPROVED');
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    it("answers 409 TEMPLATE_OTHER_ACCOUNT for a template of another account than the line's", async () => {
      const cookie = await session();
      await sync(cookie).expect(200);
      const conversationId = await closedConversation();
      await prisma.line.update({
        where: { id: lineId },
        data: { wabaId: '999' },
      });

      const res = await send(cookie, conversationId, {
        templateId: await templateId('recordatorio_turno'),
        values: ['Ana', 'jueves'],
        clientId,
      }).expect(409);

      expect((res.body as ErrorBody).code).toBe('TEMPLATE_OTHER_ACCOUNT');
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    it('answers 404 for a template of another business', async () => {
      const cookie = await session();
      const conversationId = await closedConversation();
      const other = await createLine(prisma, {
        slug: 'otro',
        phoneNumberId: '999000',
      });
      const foreign = await prisma.template.create({
        data: {
          businessId: other.businessId,
          wabaId: WABA,
          metaId: 'x',
          name: 'ajena',
          language: 'es',
          category: 'UTILITY',
          status: 'APPROVED',
          components: [{ type: 'BODY', text: 'Hola' }],
        },
      });

      await send(cookie, conversationId, {
        templateId: foreign.id,
        values: [],
        clientId,
      }).expect(404);
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    it('keeps the 409 WINDOW_CLOSED for free text and points to templates', async () => {
      const cookie = await session();
      const conversationId = await closedConversation();

      const res = await http()
        .post(
          `/inbox/businesses/${businessId}/conversations/${conversationId}/messages`,
        )
        .set('Cookie', cookie)
        .send({ body: 'hola', clientId })
        .expect(409);

      expect((res.body as ErrorBody).code).toBe('WINDOW_CLOSED');
      expect((res.body as ErrorBody).message).toContain('/templates');
      expect(sendText).not.toHaveBeenCalled();
    });
  });
});
