import { ZodError } from 'zod';
import { backfillLeads } from '../../src/leads/lead-backfill.js';
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
    it('stores the values in data with the business, and the old columns too', async () => {
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
        name: 'Ana',
        businessName: 'Consultorio Sur',
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
        name: 'Ana',
        industry: 'salud',
        need: 'turnos',
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

  describe('backfillLeads', () => {
    /** A lead as the previous release writes it: fixed columns only. */
    const legacyLead = () => prisma.$executeRaw`
      INSERT INTO lead (id, conversation_id, name, business_name, industry,
        need, contact_notes, status, created_at, updated_at)
      VALUES (gen_random_uuid(), ${conversationId}::uuid, 'Ana',
        'Consultorio Sur', NULL, 'turnos', 'por la tarde', 'NEW', now(), now())`;

    it('copies the fixed columns into data and sets the business', async () => {
      await legacyLead();

      expect(await backfillLeads(prisma)).toBe(1);

      expect(await prisma.lead.findFirstOrThrow()).toMatchObject({
        businessId,
        data: {
          name: 'Ana',
          business_name: 'Consultorio Sur',
          need: 'turnos',
          contact_notes: 'por la tarde',
        },
      });
    });

    it('is idempotent and keeps values already in data', async () => {
      await legacyLead();
      await prisma.lead.updateMany({ data: { data: { name: 'Ana María' } } });

      await backfillLeads(prisma);
      const first = await prisma.lead.findFirstOrThrow();

      expect(await backfillLeads(prisma)).toBe(0);
      const second = await prisma.lead.findFirstOrThrow();
      expect(second.data).toEqual(first.data);
      expect(second.data).toMatchObject({
        name: 'Ana María',
        business_name: 'Consultorio Sur',
      });
    });
  });
});
