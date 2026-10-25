import {
  DEFAULT_OPENING_HOURS,
  DEFAULT_OUT_OF_HOURS_MESSAGE,
  DEFAULT_PERSONA,
  seedDefaultAgentProfile,
} from '../../src/agents/default-agent-profile.seed.js';
import { loadContent } from '../../src/content/content.schema.js';
import { DEFAULT_CONTENT_DIR } from '../../src/content/content.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { connectPrisma, resetDb } from './helpers.js';

describe('Agent profiles (integration)', () => {
  let prisma: PrismaService;
  const { commercialInfo } = loadContent(DEFAULT_CONTENT_DIR);

  beforeAll(async () => {
    prisma = await connectPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    // resetDb seeds the profile like production; these tests seed it.
    await prisma.agentProfile.deleteMany();
  });

  describe('seedDefaultAgentProfile', () => {
    it('creates the BotSuite46 profile from content/commercial-info.md', async () => {
      const result = await seedDefaultAgentProfile(prisma, commercialInfo);

      expect(result).toMatchObject({ outcome: 'seeded' });
      const business = await prisma.business.findUniqueOrThrow({
        where: { slug: 'botsuite46' },
        include: { agentProfile: true },
      });
      expect(business.timezone).toBe('America/Argentina/Buenos_Aires');
      expect(business.agentProfile).toMatchObject({
        enabled: true,
        botName: business.botName,
        persona: DEFAULT_PERSONA,
        businessInfo: commercialInfo,
        faq: [],
        outOfHoursMessage: DEFAULT_OUT_OF_HOURS_MESSAGE,
        openingHours: DEFAULT_OPENING_HOURS,
        model: null,
        demoEnabled: true,
        version: 1,
      });
      expect(business.agentProfile!.businessInfo).toContain('USD 70');
      expect(business.agentProfile!.persona).not.toMatch(/asistente virtual/i);
      expect(business.agentProfile!.handoffRules).not.toBe('');
      expect(business.agentProfile!.leadFields).toEqual([
        { key: 'name', label: 'Nombre', required: true, kind: 'text' },
        {
          key: 'business_name',
          label: 'Negocio',
          required: true,
          kind: 'text',
        },
        { key: 'industry', label: 'Rubro', required: true, kind: 'text' },
        { key: 'need', label: 'Necesidad', required: true, kind: 'text' },
      ]);
    });

    it('is idempotent and keeps later edits', async () => {
      const first = await seedDefaultAgentProfile(prisma, commercialInfo);
      await prisma.agentProfile.updateMany({
        data: { persona: 'Editado', version: 2 },
      });

      const second = await seedDefaultAgentProfile(
        prisma,
        `${commercialInfo}\n\nNuevo`,
      );

      expect(second).toEqual(first);
      const profile = await prisma.agentProfile.findFirstOrThrow();
      expect(profile).toMatchObject({ persona: 'Editado', version: 2 });
      expect(profile.businessInfo).toBe(commercialInfo);
      expect(await prisma.agentProfile.count()).toBe(1);
    });

    it("starts from the business's current botName", async () => {
      await prisma.business.update({
        where: { slug: 'botsuite46' },
        data: { botName: 'Sofi, IA de BotSuite46' },
      });

      await seedDefaultAgentProfile(prisma, commercialInfo);

      const profile = await prisma.agentProfile.findFirstOrThrow();
      expect(profile.botName).toBe('Sofi, IA de BotSuite46');
    });

    it('does nothing when the default business does not exist', async () => {
      await prisma.$executeRaw`TRUNCATE line, business RESTART IDENTITY CASCADE`;

      const result = await seedDefaultAgentProfile(prisma, commercialInfo);

      expect(result).toEqual({ outcome: 'skipped' });
      expect(await prisma.agentProfile.count()).toBe(0);
    });

    it('rejects commercial info over the profile limit and writes nothing', async () => {
      await expect(
        seedDefaultAgentProfile(prisma, 'a'.repeat(8_001)),
      ).rejects.toThrow(/businessInfo/);
      expect(await prisma.agentProfile.count()).toBe(0);
    });

    it('does not validate the content again once the profile exists', async () => {
      const first = await seedDefaultAgentProfile(prisma, commercialInfo);

      await expect(
        seedDefaultAgentProfile(prisma, 'a'.repeat(8_001)),
      ).resolves.toEqual(first);
    });
  });

  it('records the profile version on AI usage rows', async () => {
    const columns = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'ai_usage' AND column_name = 'agent_profile_version'`;

    // Nullable: rows from before profiles existed have no version.
    expect(columns).toEqual([{ is_nullable: 'YES' }]);
  });
});
