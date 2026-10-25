import { ZodError } from 'zod';
import { LeadsService } from '../../src/leads/leads.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { connectPrisma, resetDb, testConfig, textEvent } from './helpers.js';

describe('Leads (integration)', () => {
  let prisma: PrismaService;
  let leads: LeadsService;
  let conversationId: string;
  let businessId: string;

  beforeAll(async () => {
    prisma = await connectPrisma();
    leads = new LeadsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    const conversations = new ConversationsService(
      prisma,
      testConfig(),
      new QueueSignal(),
    );
    await conversations.recordInbound(
      textEvent('wamid.lead.1', '5491100001234', 'hola'),
    );
    const conversation = await prisma.conversation.findFirstOrThrow({
      include: { line: true },
    });
    conversationId = conversation.id;
    businessId = conversation.line.businessId;
  });

  describe('upsertFromConversation', () => {
    it('stores the values in data with the business', async () => {
      await leads.upsertFromConversation(conversationId, {
        name: ' Ana ',
        business_name: 'Consultorio Sur',
        phone: '+5491100000000',
      });

      expect(await prisma.lead.findFirstOrThrow()).toMatchObject({
        conversationId,
        businessId,
        data: {
          name: 'Ana',
          business_name: 'Consultorio Sur',
          phone: '+5491100000000',
        },
        status: 'NEW',
      });
    });

    it('merges values and never blanks known data', async () => {
      await leads.upsertFromConversation(conversationId, {
        name: 'Ana',
        industry: 'salud',
      });
      await leads.upsertFromConversation(conversationId, {
        name: '',
        industry: '  ',
        need: 'turnos',
      });

      const [lead] = await prisma.lead.findMany();
      expect(lead).toMatchObject({
        data: { name: 'Ana', industry: 'salud', need: 'turnos' },
      });
    });

    it('writes nothing when every value is empty, and rejects invalid keys', async () => {
      expect(
        await leads.upsertFromConversation(conversationId, { name: ' ' }),
      ).toBeNull();
      await expect(
        leads.upsertFromConversation(conversationId, { businessName: 'X' }),
      ).rejects.toThrow(ZodError);
      expect(await prisma.lead.count()).toBe(0);
    });
  });

  it('a lead cannot exist without a business', async () => {
    await expect(prisma.$executeRaw`
      INSERT INTO lead (id, conversation_id, status, created_at, updated_at)
      VALUES (gen_random_uuid(), ${conversationId}::uuid, 'NEW', now(), now())`).rejects.toThrow(
      /business_id.*not-null constraint/,
    );
  });
});
