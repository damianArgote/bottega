import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { configureHttp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { UsersService } from '../../src/auth/users.service.js';
import { BotWorker } from '../../src/bot/worker.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ContextService } from '../../src/conversations/context.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { ConversationActionsService } from '../../src/inbox/conversation-actions.service.js';
import { WEBHOOK_FETCH } from '../../src/integrations/webhook-delivery.service.js';
import { LeadsService } from '../../src/leads/leads.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueService } from '../../src/queue/queue.service.js';
import { createLine, resetDb, textEvent } from './helpers.js';

// Must match ADMIN_API_KEY in vitest.config.int.ts.
const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const HOOK = 'https://n8n.example.com/webhook/bottega';
const USER = '5491100001234';

interface Created {
  id: string;
  secret: string;
}
interface KeyCreated {
  id: string;
  key: string;
}
interface Envelope {
  id: string;
  type: string;
  businessId: string;
  data: Record<string, unknown>;
}

describe('Integrations: webhook events and read API (integration)', () => {
  const hookFetch = vi.fn<typeof fetch>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let businessId: string;
  let otherBusinessId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WEBHOOK_FETCH)
      .useValue(hookFetch)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    hookFetch.mockReset();
    hookFetch.mockImplementation(() =>
      Promise.resolve(new Response('ok', { status: 200 })),
    );
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    otherBusinessId = (
      await createLine(prisma, { slug: 'otro', phoneNumberId: '999000' })
    ).businessId;
  });

  const http = () => request(app.getHttpServer());
  const admin = (path: string) => `/admin/businesses/${businessId}${path}`;
  const subscribe = async (events: string[], business = businessId) =>
    (
      await http()
        .post(`/admin/businesses/${business}/webhooks`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ url: HOOK, events })
        .expect(201)
    ).body as Created;
  /** A conversation; the bot's job for its message is dropped unless kept. */
  const conversationOf = async (
    waId: string,
    wamid: string,
    keepBotJob = false,
  ) => {
    await app.get(ConversationsService).recordInbound({
      ...textEvent(wamid, waId, 'hola'),
      timestamp: new Date(),
      profileName: 'Juan',
    });
    if (!keepBotJob) {
      await prisma.processingJob.deleteMany({
        where: { type: 'INBOUND_MESSAGE' },
      });
    }
    return (
      await prisma.conversation.findFirstOrThrow({
        where: { contact: { waId } },
      })
    ).id;
  };
  const conversationId = (keepBotJob = false) =>
    conversationOf(USER, 'wamid.in.1', keepBotJob);
  const saveLead = (id: string, values: Record<string, string>) =>
    prisma.$transaction((tx) =>
      app.get(LeadsService).upsertFromConversation(id, values, tx),
    );
  const drain = () => app.get(BotWorker).drain();
  /** Makes retried jobs runnable now (instead of waiting for the backoff). */
  const runRetriesNow = () =>
    prisma.$executeRaw`UPDATE processing_job SET run_after = now() - interval '1 day' WHERE status = 'PENDING'`;
  const sent = (call = 0) => {
    const [url, init] = hookFetch.mock.calls[call]!;
    const headers = init!.headers as Record<string, string>;
    return {
      url,
      headers,
      body: init!.body as string,
      envelope: JSON.parse(init!.body as string) as Envelope,
    };
  };

  describe('events', () => {
    it('sends lead.updated signed with the subscription secret, with ids and contact but no chat', async () => {
      const { secret } = await subscribe(['lead.updated']);
      const id = await conversationId();

      await saveLead(id, { name: 'Juan Pérez', email: 'juan@example.com' });
      expect(await drain()).toBe(1);

      const { url, headers, body, envelope } = sent();
      expect(url).toBe(HOOK);
      expect(headers['X-Bottega-Event']).toBe('lead.updated');
      const expected = createHmac('sha256', secret)
        .update(`${headers['X-Bottega-Timestamp']}.${body}`)
        .digest('hex');
      expect(headers['X-Bottega-Signature']).toBe(`sha256=${expected}`);
      expect(
        Math.abs(Number(headers['X-Bottega-Timestamp']) - Date.now() / 1000),
      ).toBeLessThan(60);
      expect(envelope).toMatchObject({
        type: 'lead.updated',
        businessId,
        data: {
          lead: {
            status: 'NEW',
            data: { name: 'Juan Pérez', email: 'juan@example.com' },
          },
          conversation: { id },
          contact: { waId: USER, name: 'Juan' },
        },
      });
      expect(body).not.toContain('hola');
      expect(
        await prisma.processingJob.findFirstOrThrow({
          where: { type: 'WEBHOOK_DELIVERY' },
        }),
      ).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    });

    it('sends no lead.updated when nothing changed', async () => {
      await subscribe(['lead.updated']);
      const id = await conversationId();

      await saveLead(id, { name: 'Juan' });
      await saveLead(id, { name: 'Juan' });

      expect(await prisma.webhookDelivery.count()).toBe(1);
    });

    it('retries a 500 with backoff, records the error, and stops after a 2xx', async () => {
      await subscribe(['lead.updated']);
      const id = await conversationId();
      hookFetch.mockImplementationOnce(() =>
        Promise.resolve(new Response('boom', { status: 500 })),
      );

      await saveLead(id, { name: 'Juan' });
      await drain();

      const job = await prisma.processingJob.findFirstOrThrow({
        where: { type: 'WEBHOOK_DELIVERY' },
      });
      expect(job).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());
      expect(job.maxAttempts).toBe(6);
      const subscription = await prisma.webhookSubscription.findFirstOrThrow();
      expect(subscription.lastError).toBe('http_500');
      expect(
        (await prisma.webhookDelivery.findFirstOrThrow()).responseStatus,
      ).toBe(500);

      await runRetriesNow();
      await drain();

      expect(hookFetch).toHaveBeenCalledTimes(2);
      expect(
        await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({ status: 'COMPLETED', attempts: 2 });
      expect(
        (await prisma.webhookDelivery.findFirstOrThrow()).deliveredAt,
      ).not.toBeNull();
      // Both attempts carried the same event and delivery ids.
      expect(sent(0).headers['X-Bottega-Delivery']).toBe(
        sent(1).headers['X-Bottega-Delivery'],
      );
    });

    it('fails a delivery after its 6 attempts', async () => {
      await subscribe(['lead.updated']);
      const id = await conversationId();
      hookFetch.mockImplementation(() =>
        Promise.reject(new TypeError('fetch failed')),
      );

      await saveLead(id, { name: 'Juan' });
      for (let i = 0; i < 6; i += 1) {
        await runRetriesNow();
        await drain();
      }

      expect(hookFetch).toHaveBeenCalledTimes(6);
      expect(
        await prisma.processingJob.findFirstOrThrow({
          where: { type: 'WEBHOOK_DELIVERY' },
        }),
      ).toMatchObject({ status: 'FAILED', attempts: 6 });
      expect(
        (await prisma.webhookSubscription.findFirstOrThrow()).lastError,
      ).toBe('network_error');
    });

    it('never holds back the bot: a delivery is claimable while the conversation has an older job', async () => {
      await subscribe(['handoff.requested']);
      const id = await conversationId(true);
      // recordInbound enqueued the bot's job (not processed here).
      await app.get(ContextService).requestHuman(id, 'quiere una persona');

      const claimed = [];
      const queue = app.get(QueueService);
      for (
        let job = await queue.claimNext('w');
        job;
        job = await queue.claimNext('w')
      ) {
        claimed.push(job.type);
      }
      expect(claimed.sort()).toEqual(['INBOUND_MESSAGE', 'WEBHOOK_DELIVERY']);
    });

    it('sends handoff.requested with its reason, and conversation.resolved once with who resolved it', async () => {
      await subscribe(['handoff.requested', 'conversation.resolved']);
      const id = await conversationId();
      const { user } = await app.get(UsersService).addToBusiness(businessId, {
        email: 'ana@example.com',
        name: 'Ana',
        password: PASSWORD,
        role: 'AGENT',
      });

      await app.get(ContextService).requestHuman(id, 'quiere una persona');
      const actions = app.get(ConversationActionsService);
      const access = { businessId, role: 'AGENT' as const };
      const session = { ...user, mustChangePassword: false };
      await actions.resolve(access, session, id);
      await actions.resolve(access, session, id);
      await drain();

      const envelopes = hookFetch.mock.calls.map((_, i) => sent(i).envelope);
      expect(envelopes.map((e) => e.type)).toEqual([
        'handoff.requested',
        'conversation.resolved',
      ]);
      expect(envelopes[0]!.data['handoff']).toMatchObject({
        reason: 'quiere una persona',
      });
      expect(envelopes[1]!.data['resolvedBy']).toEqual({
        id: user.id,
        name: 'Ana',
      });
    });

    it('enqueues nothing when the change rolls back', async () => {
      await subscribe(['lead.updated']);
      const id = await conversationId();

      await expect(
        prisma.$transaction(async (tx) => {
          await app
            .get(LeadsService)
            .upsertFromConversation(id, { name: 'Juan' }, tx);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      expect(await prisma.webhookDelivery.count()).toBe(0);
      expect(
        await prisma.processingJob.count({
          where: { type: 'WEBHOOK_DELIVERY' },
        }),
      ).toBe(0);
    });

    it('never holds back the bot while an older delivery runs or retries', async () => {
      await subscribe(['lead.updated']);
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });
      const queue = app.get(QueueService);
      const hook = await queue.claimNext('w1');
      expect(hook?.type).toBe('WEBHOOK_DELIVERY');

      await conversationOf(USER, 'wamid.in.2', true);
      const inbound = await queue.claimNext('w2');
      expect(inbound?.type).toBe('INBOUND_MESSAGE');

      await queue.fail(inbound!, new Error('x'), { retryable: true });
      await queue.fail(hook!, new Error('x'), { retryable: true });
      await runRetriesNow();
      const claimed = [
        (await queue.claimNext('w3'))?.type,
        (await queue.claimNext('w4'))?.type,
      ];
      expect(claimed.sort()).toEqual(['INBOUND_MESSAGE', 'WEBHOOK_DELIVERY']);
    });

    it('runs one delivery at a time, so the bot always keeps a free worker', async () => {
      await subscribe(['lead.updated']);
      await subscribe(['lead.updated']);
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });
      await conversationOf(USER, 'wamid.in.2', true);
      const queue = app.get(QueueService);

      const first = await queue.claimNext('w1');
      const second = await queue.claimNext('w2');
      const third = await queue.claimNext('w3');

      expect(first?.type).toBe('WEBHOOK_DELIVERY');
      expect(second?.type).toBe('INBOUND_MESSAGE');
      expect(third).toBeNull();

      // Once it finishes, the other delivery can run.
      await queue.complete(first!);
      expect((await queue.claimNext('w4'))?.type).toBe('WEBHOOK_DELIVERY');
    });

    it('takes over a delivery whose worker died (lease expired)', async () => {
      await subscribe(['lead.updated']);
      await subscribe(['lead.updated']);
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });
      const queue = app.get(QueueService);
      const stuck = await queue.claimNext('w1');
      await prisma.$executeRaw`UPDATE processing_job SET lease_expires_at = now() - interval '1 day' WHERE id = ${stuck!.id}::uuid`;

      const next = await queue.claimNext('w2');

      expect(next?.type).toBe('WEBHOOK_DELIVERY');
    });

    it('does not follow a redirect: it is a failure to retry', async () => {
      await subscribe(['lead.updated']);
      const id = await conversationId();
      hookFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example' },
          }),
        ),
      );

      await saveLead(id, { name: 'Juan' });
      await drain();

      expect(hookFetch.mock.calls[0]![1]!.redirect).toBe('manual');
      expect(hookFetch).toHaveBeenCalledTimes(1);
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({
        lastError: 'http_302',
        deliveredAt: null,
      });
      expect(
        await prisma.processingJob.findFirstOrThrow({
          where: { type: 'WEBHOOK_DELIVERY' },
        }),
      ).toMatchObject({ status: 'PENDING', attempts: 1 });
    });

    it('only enqueues for active subscriptions of the business that want the event', async () => {
      await subscribe(['handoff.requested']);
      const off = await subscribe(['lead.updated']);
      await http()
        .patch(admin(`/webhooks/${off.id}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ active: false })
        .expect(200);
      await subscribe(['lead.updated'], otherBusinessId);
      const id = await conversationId();

      await saveLead(id, { name: 'Juan' });

      expect(await prisma.webhookDelivery.count()).toBe(0);
    });

    it('skips pending deliveries of a subscription turned off', async () => {
      const sub = await subscribe(['lead.updated']);
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });
      await prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: { active: false },
      });

      await drain();

      expect(hookFetch).not.toHaveBeenCalled();
      expect(
        await prisma.processingJob.findFirstOrThrow({
          where: { type: 'WEBHOOK_DELIVERY' },
        }),
      ).toMatchObject({ status: 'SKIPPED' });
    });
  });

  describe('subscriptions (admin)', () => {
    it('shows the secret only when created or rotated, stores it encrypted, and takes https only', async () => {
      const created = await subscribe(['lead.updated']);
      expect(created.secret).toMatch(/^whsec_/);

      const list = await http()
        .get(admin('/webhooks'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect(JSON.stringify(list.body)).not.toContain(created.secret);
      expect(
        (await prisma.webhookSubscription.findFirstOrThrow()).secretEncrypted,
      ).not.toContain(created.secret);

      const rotated = await http()
        .post(admin(`/webhooks/${created.id}/rotate-secret`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect((rotated.body as Created).secret).not.toBe(created.secret);

      await http()
        .post(admin('/webhooks'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ url: 'http://n8n.example.com/x', events: ['lead.updated'] })
        .expect(400);
      await http()
        .post(admin('/webhooks'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ url: HOOK, events: ['booking.confirmed'] })
        .expect(400);
    });

    it('never touches another business subscription or key', async () => {
      const foreign = await subscribe(['lead.updated'], otherBusinessId);
      await http()
        .post(admin(`/webhooks/${foreign.id}/rotate-secret`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(404);
      const foreignKey = (
        await http()
          .post(`/admin/businesses/${otherBusinessId}/integration-keys`)
          .set('X-Admin-Api-Key', ADMIN_KEY)
          .send({ name: 'x' })
          .expect(201)
      ).body as KeyCreated;
      await http()
        .delete(admin(`/integration-keys/${foreignKey.id}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(404);

      await http()
        .patch(admin(`/webhooks/${foreign.id}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ active: false })
        .expect(404);
      await http()
        .delete(admin(`/webhooks/${foreign.id}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(404);
    });

    it('is only for the admin key or the team (staff)', async () => {
      await http().get(admin('/webhooks')).expect(401);
      const users = app.get(UsersService);
      const { user } = await users.addToBusiness(businessId, {
        email: 'olga@example.com',
        name: 'Olga',
        password: PASSWORD,
        role: 'OWNER',
      });
      const login = async () => {
        const res = await http()
          .post('/auth/login')
          .send({ email: 'olga@example.com', password: PASSWORD })
          .expect(200);
        return (res.headers['set-cookie'] as unknown as string[])
          .find((c) => c.startsWith('bottega_session='))!
          .split(';')[0]!;
      };
      const staffPath = `/staff/businesses/${businessId}/integration-keys`;

      const owner = await login();
      await http().get(staffPath).set('Cookie', owner).expect(403);

      await http()
        .put(`/admin/users/${user.id}/staff`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ staff: true })
        .expect(200);
      const staff = await login();
      const res = await http()
        .post(staffPath)
        .set('Cookie', staff)
        .send({ name: 'n8n' })
        .expect(201);
      expect((res.body as KeyCreated).key).toMatch(/^btg_/);
    });
  });

  describe('read API', () => {
    const createKey = async (business = businessId) =>
      (
        (
          await http()
            .post(`/admin/businesses/${business}/integration-keys`)
            .set('X-Admin-Api-Key', ADMIN_KEY)
            .send({ name: 'n8n' })
            .expect(201)
        ).body as KeyCreated
      ).key;

    it('lists the key business leads and conversations, without messages', async () => {
      const key = await createKey();
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });

      const leads = await http()
        .get('/integrations/v1/leads')
        .set('X-Api-Key', key)
        .expect(200);
      expect(leads.body).toMatchObject({
        data: [
          {
            data: { name: 'Juan' },
            status: 'NEW',
            conversation: { id },
            contact: { waId: USER, name: 'Juan' },
          },
        ],
      });

      const conversations = await http()
        .get('/integrations/v1/conversations')
        .set('Authorization', `Bearer ${key}`)
        .expect(200);
      expect(conversations.body).toMatchObject({
        data: [{ id, status: 'OPEN', contact: { waId: USER } }],
      });
      expect(JSON.stringify(conversations.body)).not.toContain('hola');
    });

    it('never shows another business data with a key', async () => {
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });
      const otherKey = await createKey(otherBusinessId);

      for (const path of ['leads', 'conversations']) {
        const res = await http()
          .get(`/integrations/v1/${path}`)
          .set('X-Api-Key', otherKey)
          .expect(200);
        expect(res.body).toEqual({ data: [], nextCursor: null });
      }
    });

    it('pages with nextCursor and continues after the last row seen', async () => {
      const key = await createKey();
      const id = await conversationId();
      await saveLead(id, { name: 'Juan' });

      const first = await http()
        .get('/integrations/v1/leads')
        .set('X-Api-Key', key)
        .expect(200);
      const cursor = (first.body as { nextCursor: string }).nextCursor;
      const next = await http()
        .get(`/integrations/v1/leads?cursor=${cursor}`)
        .set('X-Api-Key', key)
        .expect(200);
      expect((next.body as { data: unknown[] }).data).toEqual([]);

      await saveLead(id, { email: 'juan@example.com' });
      const changed = await http()
        .get(`/integrations/v1/leads?cursor=${cursor}`)
        .set('X-Api-Key', key)
        .expect(200);
      expect((changed.body as { data: unknown[] }).data).toHaveLength(1);

      await http()
        .get('/integrations/v1/leads?cursor=nope')
        .set('X-Api-Key', key)
        .expect(400);
    });

    it('pages rows with the same updatedAt without skipping or repeating any', async () => {
      const key = await createKey();
      for (let i = 0; i < 101; i += 1) {
        const id = await conversationOf(
          `54911${String(i).padStart(8, '0')}`,
          `wamid.p${i}`,
        );
        await saveLead(id, { name: `N${i}` });
      }
      await prisma.$executeRaw`UPDATE lead SET updated_at = '2026-10-01T00:00:00Z'`;

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const res = await http()
          .get(`/integrations/v1/leads${cursor ? `?cursor=${cursor}` : ''}`)
          .set('X-Api-Key', key)
          .expect(200);
        const body = res.body as {
          data: { id: string }[];
          nextCursor: string | null;
        };
        if (body.data.length === 0) {
          break;
        }
        seen.push(...body.data.map((d) => d.id));
        cursor = body.nextCursor;
      }
      expect(seen).toHaveLength(101);
      expect(new Set(seen).size).toBe(101);
    }, 60_000);

    it('rejects missing, wrong and revoked keys, and stores only the hash', async () => {
      const key = await createKey();
      const stored = await prisma.integrationKey.findFirstOrThrow();
      expect(stored.keyHash).not.toContain(key);
      expect(stored.prefix).toBe(key.slice(0, 10));

      await http().get('/integrations/v1/leads').expect(401);
      await http()
        .get('/integrations/v1/leads')
        .set('X-Api-Key', `${key}x`)
        .expect(401);
      await http()
        .get('/integrations/v1/leads')
        .set('X-Api-Key', key)
        .expect(200);
      expect(
        (await prisma.integrationKey.findFirstOrThrow()).lastUsedAt,
      ).not.toBeNull();

      await http()
        .delete(admin(`/integration-keys/${stored.id}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      await http()
        .get('/integrations/v1/leads')
        .set('X-Api-Key', key)
        .expect(401);
    });
  });
});
