import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AiProviderError,
  type AiProvider,
  type AiResponse,
} from '../../src/ai/ai.provider.js';
import type { AgentProfileInput } from '../../src/agents/agent-profile.schema.js';
import { AgentsService } from '../../src/agents/agents.service.js';
import { AgentPreviewService } from '../../src/bot/agent-preview.service.js';
import { renderReply } from '../../src/bot/replies.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { connectPrisma, createLine, resetDb, testConfig } from './helpers.js';

const MODEL = 'env-model';

const profile: AgentProfileInput = {
  enabled: false,
  botName: 'Lola, IA de Peluquería Lola',
  persona: 'Simpática.',
  businessInfo: '## Servicios\n- Brushing: $9.000',
  faq: [{ question: '¿Atienden con turno?', answer: 'Solo con turno.' }],
  leadFields: [
    { key: 'name', label: 'Nombre', required: true, kind: 'text' },
    { key: 'phone', label: 'Celular', required: false, kind: 'phone' },
  ],
  handoffRules: 'Si es un reclamo.',
  outOfHoursMessage: 'Abrimos de martes a sábado.',
  openingHours: { tue: ['10:00-19:00'], sat: ['10:00-14:00'] },
  model: 'profile-model',
  demoEnabled: false,
};

const text = (outputText: string): AiResponse => ({
  outputText,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'served-model',
});

const tool = (name: string, args: Record<string, unknown>): AiResponse => ({
  outputText: '',
  toolCalls: [
    { callId: `call_${name}`, name, arguments: JSON.stringify(args) },
  ],
  usage: { inputTokens: 20, outputTokens: 8 },
  model: 'served-model',
});

describe('Admin agent profile and preview (integration)', () => {
  const respond = vi.fn<AiProvider['respond']>();
  let prisma: PrismaService;
  let agents: AgentsService;
  let preview: AgentPreviewService;
  let botsuiteId: string;
  let salonId: string;

  beforeAll(async () => {
    prisma = await connectPrisma();
    agents = new AgentsService(prisma);
    preview = new AgentPreviewService(
      prisma,
      { respond },
      testConfig({ OPENAI_MODEL: MODEL }),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    respond.mockReset();
    botsuiteId = (
      await prisma.business.findUniqueOrThrow({
        where: { slug: 'botsuite46' },
      })
    ).id;
    salonId = (await createLine(prisma, { slug: 'lola', phoneNumberId: '222' }))
      .businessId;
  });

  /** Rows the preview must never write. */
  const writes = async () => ({
    messages: await prisma.message.count(),
    leads: await prisma.lead.count(),
    usage: await prisma.aiUsage.count(),
    handoffs: await prisma.handoffRequest.count(),
    jobs: await prisma.processingJob.count(),
  });
  const noWrites = {
    messages: 0,
    leads: 0,
    usage: 0,
    handoffs: 0,
    jobs: 0,
  };

  describe('get and put', () => {
    it('returns the stored profile with its version', async () => {
      expect(await agents.get(botsuiteId)).toMatchObject({
        businessId: botsuiteId,
        botName: 'Bot de botsuite46',
        demoEnabled: true,
        version: 1,
      });
    });

    it('404s for an unknown business or a business without a profile', async () => {
      await expect(
        agents.get('00000000-0000-4000-8000-000000000000'),
      ).rejects.toThrow(NotFoundException);
      await expect(agents.get(salonId)).rejects.toThrow(NotFoundException);
    });

    it('answers without the author, as before the backoffice', async () => {
      expect(await agents.put(salonId, profile)).not.toHaveProperty(
        'updatedBy',
      );
      expect(await agents.get(salonId)).not.toHaveProperty('updatedBy');
    });

    it('creates the profile with version 1, and every put raises the version', async () => {
      expect(await agents.put(salonId, profile)).toMatchObject({
        ...profile,
        businessId: salonId,
        version: 1,
      });
      expect(
        await agents.put(salonId, { ...profile, persona: 'Seria.' }),
      ).toMatchObject({ persona: 'Seria.', version: 2 });
      expect(await agents.put(salonId, profile)).toMatchObject({ version: 3 });
      expect(await agents.get(salonId)).toMatchObject({
        ...profile,
        version: 3,
      });
    });

    it("leaves other businesses' profiles alone", async () => {
      const before = await agents.get(botsuiteId);

      await agents.put(salonId, profile);

      expect(await agents.get(botsuiteId)).toEqual(before);
    });

    it('404s when putting to an unknown business', async () => {
      await expect(
        agents.put('00000000-0000-4000-8000-000000000000', profile),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('preview', () => {
    it("runs a turn with the business's agent, even switched off, and writes or sends nothing", async () => {
      await agents.put(salonId, profile);
      respond
        .mockResolvedValueOnce(tool('save_lead', { name: 'Ana', phone: null }))
        .mockResolvedValueOnce(text('¡Gracias, Ana!'));

      const result = await preview.run(salonId, [
        { role: 'assistant', content: '¡Hola! ¿Cómo te llamás?' },
        { role: 'user', content: 'Soy Ana' },
      ]);

      expect(result).toEqual({
        reply: '¡Gracias, Ana!',
        buttons: [],
        toolCalls: [
          {
            name: 'save_lead',
            arguments: { name: 'Ana', phone: null },
            accepted: true,
          },
        ],
        model: 'profile-model',
        agentProfileVersion: 1,
        usage: { calls: 2, inputTokens: 30, outputTokens: 13 },
      });
      const request = respond.mock.calls[0]?.[0];
      expect(request?.model).toBe('profile-model');
      expect(request?.instructions).toContain(
        'Sos Lola, IA de Peluquería Lola.',
      );
      expect(request?.instructions).not.toContain('BotSuite');
      expect(request?.tools.map((t) => t.name)).toEqual([
        'save_lead',
        'request_handoff',
        'offer_options',
      ]);
      expect(request?.input).toEqual([
        {
          kind: 'message',
          role: 'assistant',
          content: '¡Hola! ¿Cómo te llamás?',
        },
        { kind: 'message', role: 'user', content: 'Soy Ana' },
      ]);
      expect(await writes()).toEqual(noWrites);
    });

    it('reports rejected tool calls and uses OPENAI_MODEL without a profile model', async () => {
      await agents.put(salonId, { ...profile, model: null });
      respond
        .mockResolvedValueOnce(
          tool('save_lead', { name: null, phone: 'llamame' }),
        )
        .mockResolvedValueOnce(
          text('¿Me pasás tu celular con característica?'),
        );

      const result = await preview.run(salonId, [
        { role: 'user', content: 'mi cel es llamame' },
      ]);

      expect(result.model).toBe(MODEL);
      expect(result.toolCalls).toEqual([
        {
          name: 'save_lead',
          arguments: { name: null, phone: 'llamame' },
          accepted: false,
          reason: 'invalid_arguments',
        },
      ]);
    });

    it('shows the fixed handoff reply and pauses nothing', async () => {
      await agents.put(salonId, profile);
      respond.mockResolvedValueOnce(
        tool('request_handoff', { reason: 'reclamo' }),
      );

      const result = await preview.run(salonId, [
        { role: 'user', content: 'quiero hacer un reclamo' },
      ]);

      expect(result.reply).toBe(
        renderReply('HUMAN_REQUESTED', {
          demoBusinessName: '',
          botName: profile.botName,
        }),
      );
      expect(result.toolCalls).toMatchObject([
        { name: 'request_handoff', accepted: true },
      ]);
      expect(await prisma.conversation.count({ where: { paused: true } })).toBe(
        0,
      );
      expect(await writes()).toEqual(noWrites);
    });

    it('404s without a stored profile', async () => {
      await expect(
        preview.run(salonId, [{ role: 'user', content: 'hola' }]),
      ).rejects.toThrow(NotFoundException);
      expect(respond).not.toHaveBeenCalled();
    });

    it('answers 503 when the model call fails', async () => {
      respond.mockRejectedValueOnce(
        new AiProviderError('openai_http_500', true),
      );

      await expect(
        preview.run(botsuiteId, [{ role: 'user', content: 'hola' }]),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(await writes()).toEqual(noWrites);
    });
  });
});
