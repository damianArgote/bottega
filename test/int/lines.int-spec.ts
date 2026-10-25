import { AdminService } from '../../src/admin/admin.service.js';
import { EchoReplyGenerator } from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContextService } from '../../src/conversations/context.service.js';
import { QueueService } from '../../src/queue/queue.service.js';
import { fixedClientFactory } from '../fixtures/client-factory.js';
import { randomBytes } from 'node:crypto';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { CredentialsCipher } from '../../src/lines/credentials-cipher.js';
import {
  DEFAULT_BOT_NAME,
  seedDefaultLine,
} from '../../src/lines/default-line.seed.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import {
  DEFAULT_PHONE_NUMBER_ID,
  buildBotService,
  connectPrisma,
  createLine,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';

async function emptyDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE conversation, conversation_context, message, processing_job,
      lead, demo_request, handoff_request, ai_usage, contact, webhook_event,
      line, agent_profile, membership, app_user, business
      RESTART IDENTITY CASCADE`;
}

describe('Businesses, lines and contacts (integration)', () => {
  let prisma: PrismaService;
  let conversations: ConversationsService;
  const cipher = new CredentialsCipher(randomBytes(32));
  const seedEnv = {
    WHATSAPP_PHONE_NUMBER_ID: DEFAULT_PHONE_NUMBER_ID,
    META_APP_SECRET: 'env-app-secret',
    WHATSAPP_ACCESS_TOKEN: 'env-access-token',
  };

  beforeAll(async () => {
    prisma = await connectPrisma();
    conversations = new ConversationsService(
      prisma,
      testConfig(),
      new QueueSignal(),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await emptyDb(prisma);
  });

  describe('seedDefaultLine', () => {
    it('creates the default business and line with encrypted env credentials', async () => {
      const result = await seedDefaultLine(prisma, cipher, seedEnv);

      expect(result).toMatchObject({ outcome: 'seeded' });
      const business = await prisma.business.findUniqueOrThrow({
        where: { slug: 'botsuite46' },
        include: { lines: true },
      });
      expect(business).toMatchObject({
        name: 'BotSuite46',
        botName: DEFAULT_BOT_NAME,
      });
      expect(DEFAULT_BOT_NAME).toBe('BotSuite, IA de BotSuite46');
      const [line] = business.lines;
      expect(line).toMatchObject({
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        active: true,
      });
      expect(line!.webhookKey).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(line!.verifyToken.length).toBeGreaterThanOrEqual(32);
      expect(line!.appSecretEncrypted).not.toContain('env-app-secret');
      expect(cipher.decrypt(line!.appSecretEncrypted!)).toBe('env-app-secret');
      expect(cipher.decrypt(line!.accessTokenEncrypted!)).toBe(
        'env-access-token',
      );
    });

    it('a conversation cannot exist without a line and a contact', async () => {
      await expect(prisma.$executeRaw`
        INSERT INTO conversation (id, mode, paused, created_at, updated_at)
        VALUES (gen_random_uuid(), 'COMMERCIAL', false, now(), now())`).rejects.toThrow(
        /(line_id|contact_id).*not-null constraint/,
      );
    });

    it('is idempotent: a second run keeps ids, keys and counts', async () => {
      await seedDefaultLine(prisma, cipher, seedEnv);
      const before = await prisma.line.findFirstOrThrow();

      const second = await seedDefaultLine(prisma, cipher, seedEnv);

      expect(second).toMatchObject({ outcome: 'seeded' });
      const after = await prisma.line.findFirstOrThrow();
      expect(after.id).toBe(before.id);
      expect(after.webhookKey).toBe(before.webhookKey);
      expect(after.verifyToken).toBe(before.verifyToken);
      expect(await prisma.business.count()).toBe(1);
      expect(await prisma.line.count()).toBe(1);
    });

    it('updates the stored credentials when the env values change', async () => {
      await seedDefaultLine(prisma, cipher, seedEnv);

      await seedDefaultLine(prisma, cipher, {
        ...seedEnv,
        WHATSAPP_ACCESS_TOKEN: 'rotated-token',
      });

      const line = await prisma.line.findFirstOrThrow();
      expect(cipher.decrypt(line.accessTokenEncrypted!)).toBe('rotated-token');
    });

    it('does nothing without WHATSAPP_PHONE_NUMBER_ID', async () => {
      const result = await seedDefaultLine(prisma, cipher, {
        WHATSAPP_PHONE_NUMBER_ID: undefined,
      });

      expect(result).toEqual({ outcome: 'skipped' });
      expect(await prisma.business.count()).toBe(0);
    });
  });

  describe('recordInbound per line', () => {
    it('keeps the same wa_id on two businesses as two contacts and two conversations', async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });
      const b = await createLine(prisma, { slug: 'b', phoneNumberId: '222' });

      await conversations.recordInbound(textEvent('wamid.a', USER), a);
      await conversations.recordInbound(textEvent('wamid.b', USER), b);

      const contacts = await prisma.contact.findMany({
        orderBy: { businessId: 'asc' },
      });
      expect(contacts).toHaveLength(2);
      expect(new Set(contacts.map((c) => c.businessId))).toEqual(
        new Set([a.businessId, b.businessId]),
      );
      const threads = await prisma.conversation.findMany();
      expect(threads).toHaveLength(2);
      expect(new Set(threads.map((t) => t.lineId))).toEqual(
        new Set([a.lineId, b.lineId]),
      );
      for (const thread of threads) {
        const contact = contacts.find((c) => c.id === thread.contactId);
        expect(contact?.businessId).toBe(
          thread.lineId === a.lineId ? a.businessId : b.businessId,
        );
      }
    });

    it('reopens the same thread for the same contact on the same line', async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });

      const first = await conversations.recordInbound(
        textEvent('wamid.1', USER),
        a,
      );
      const second = await conversations.recordInbound(
        textEvent('wamid.2', USER),
        a,
      );

      expect(first.outcome).toBe('created');
      expect(second).toMatchObject({
        outcome: 'created',
        conversationId: first.outcome === 'created' && first.conversationId,
      });
      expect(await prisma.conversation.count()).toBe(1);
      expect(await prisma.message.count()).toBe(2);
    });

    it('stores the wa_id on the contact', async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });

      await conversations.recordInbound(textEvent('wamid.1', USER), a);

      const thread = await prisma.conversation.findFirstOrThrow({
        include: { contact: true },
      });
      expect(thread.contact.waId).toBe(USER);
    });

    it('conversation has no wa_id column; inbound, bot reply and admin view work', async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });
      const sent: Array<{ to: string }> = [];
      const worker = new BotWorker(
        testConfig(),
        new QueueService(prisma, testConfig()),
        buildBotService(
          prisma,
          {
            sendText: (to) => {
              sent.push({ to });
              return Promise.resolve({
                kind: 'sent',
                waMessageId: 'wamid.out',
              });
            },
          },
          new EchoReplyGenerator(),
        ),
        new QueueSignal(),
      );
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'conversation'`;

      const result = await conversations.recordInbound(
        { ...textEvent('wamid.1', USER), timestamp: new Date() },
        a,
      );
      await worker.drain();
      const admin = new AdminService(
        prisma,
        new ContextService(prisma),
        fixedClientFactory({
          sendText: () =>
            Promise.resolve({ kind: 'sent', waMessageId: 'wamid.h' }),
        }),
      );
      const view = await admin.getConversation(
        result.outcome === 'created' ? result.conversationId : '',
        10,
      );

      expect(columns.map((c) => c.column_name)).not.toContain('wa_id');
      expect(sent).toEqual([{ to: USER }]);
      expect(view.conversation.waId).toBe(USER);
    });

    it('stores the profile name Meta sends on the contact', async () => {
      const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });

      await conversations.recordInbound(
        { ...textEvent('wamid.1', USER), profileName: 'Ana' },
        a,
      );

      expect(await prisma.contact.findFirstOrThrow()).toMatchObject({
        waId: USER,
        profileName: 'Ana',
      });
    });

    it('routes to the default line when no line is given', async () => {
      await seedDefaultLine(prisma, cipher, seedEnv);

      await conversations.recordInbound(textEvent('wamid.1', USER));

      const thread = await prisma.conversation.findFirstOrThrow({
        include: { line: true },
      });
      expect(thread.line?.phoneNumberId).toBe(DEFAULT_PHONE_NUMBER_ID);
    });

    it('creates nothing when there is no default line', async () => {
      const result = await conversations.recordInbound(
        textEvent('wamid.1', USER),
      );

      expect(result).toEqual({ outcome: 'unrouted' });
      expect(await prisma.message.count()).toBe(0);
      expect(await prisma.conversation.count()).toBe(0);
      expect(await prisma.contact.count()).toBe(0);
    });
  });
});
