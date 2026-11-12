import { Logger } from '@nestjs/common';
import type {
  AiInputItem,
  AiProvider,
  AiRequest,
  AiResponse,
} from '../../src/ai/ai.provider.js';
import { AiLimitsService } from '../../src/ai/ai-limits.service.js';
import { AiUsageService } from '../../src/ai/ai-usage.service.js';
import { AiReplyGenerator } from '../../src/bot/ai-reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContentService } from '../../src/content/content.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type { SendOutcome } from '../../src/whatsapp/whatsapp.client.js';
import {
  buildBotService,
  buildBusinessModules,
  connectPrisma,
  createLine,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';
const MODEL = 'test-model';
const RULE =
  'Poné una etiqueta solo cuando la persona lo dijo claramente o se desprende de lo que pide. Nunca le digas al cliente qué etiquetas tiene.';

const text = (outputText: string): AiResponse => ({
  outputText,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: MODEL,
});

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): AiResponse => ({
  outputText: '',
  toolCalls: [
    { callId: `call_${(callSeq += 1)}`, name, arguments: JSON.stringify(args) },
  ],
  usage: { inputTokens: 20, outputTokens: 8 },
  model: MODEL,
});

const toolResults = (request: AiRequest | undefined) =>
  (request?.input ?? []).flatMap((item: AiInputItem) =>
    item.kind === 'tool_result' ? [JSON.parse(item.output) as unknown] : [],
  );

describe('tag_contact (integration, mocked model)', () => {
  const config = testConfig();
  const sendText = vi.fn<(to: string, body: string) => Promise<SendOutcome>>();
  const respond = vi.fn<AiProvider['respond']>();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let worker: BotWorker;
  let businessId: string;
  let seq = 0;

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    respond.mockReset();
    sendText.mockReset();
    sendText.mockImplementation(() =>
      Promise.resolve({ kind: 'sent', waMessageId: `wamid.out.${(seq += 1)}` }),
    );
    businessId = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    // Within BotSuite46's opening hours: no out-of-hours notice.
    const aiConfig = testConfig({
      BOT_REPLY_MODE: 'ai',
      OPENAI_API_KEY: 'unused',
      OPENAI_MODEL: MODEL,
    });
    const generator = new AiReplyGenerator({
      provider: { respond },
      usage: new AiUsageService(prisma),
      limits: new AiLimitsService(prisma, aiConfig),
      modules: buildBusinessModules(prisma, aiConfig),
      prisma,
      content: new ContentService(),
      config: aiConfig,
      clock: () => new Date('2026-10-26T15:00:00Z'),
    });
    worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      buildBotService(prisma, { sendText }, generator),
      new QueueSignal(),
    );
  });

  const say = async (body: string) => {
    await conversations.recordInbound(
      textEvent(`wamid.in.${(seq += 1)}`, USER, body),
    );
    await worker.drain();
  };
  const request = (index: number) => respond.mock.calls.at(index)?.[0];
  const tagTool = (index: number) =>
    request(index)?.tools.find((t) => t.name === 'tag_contact');
  const contact = () =>
    prisma.contact.findFirstOrThrow({ where: { waId: USER } });
  const tag = (
    name: string,
    key: string,
    assignedBy: 'BOT' | 'PERSON',
    business = businessId,
  ) =>
    prisma.contactTag.create({
      data: {
        businessId: business,
        name,
        nameKey: key,
        key,
        assignedBy,
        botHint: assignedBy === 'BOT' ? `Cuando dice ${name}` : null,
        color: 'gray',
      },
    });
  const assignments = async () =>
    (
      await prisma.contactTagAssignment.findMany({
        include: { tag: { select: { key: true } } },
        orderBy: { tag: { key: 'asc' } },
      })
    ).map((a) => ({
      key: a.tag.key,
      source: a.source,
      createdById: a.createdById,
      removed: a.removedAt !== null,
    }));

  it('a business without BOT tags gets no tag_contact and no tag rule', async () => {
    await tag('VIP', 'vip', 'PERSON');
    respond.mockResolvedValueOnce(text('¡Hola!'));

    await say('hola');

    expect(tagTool(0)).toBeUndefined();
    expect(request(0)?.instructions).not.toContain(RULE);
  });

  it('puts a BOT tag on the contact, emits the event and the reply never mentions an error', async () => {
    await tag('Mayorista', 'mayorista', 'BOT');
    await prisma.webhookSubscription.create({
      data: {
        businessId,
        url: 'https://n8n.example.com/hook',
        secretEncrypted: new LineCredentialsService(config).encrypt('whsec_x'),
        events: ['contact.tags_changed'],
      },
    });
    respond
      .mockResolvedValueOnce(
        tool('tag_contact', { add: ['mayorista'], remove: [] }),
      )
      .mockResolvedValueOnce(text('¡Genial! Te paso los precios por bulto.'));

    await say('compro por cantidad para revender');

    expect(tagTool(0)).toMatchObject({
      parameters: { properties: { add: { items: { enum: ['mayorista'] } } } },
    });
    expect(request(0)?.instructions).toContain(RULE);
    expect(toolResults(request(1))).toEqual([
      {
        ok: true,
        note: 'Listo. No le digas a la persona qué etiquetas tiene.',
      },
    ]);
    expect(sendText.mock.calls.at(-1)?.[1]).toBe(
      '¡Genial! Te paso los precios por bulto.',
    );
    expect(await assignments()).toEqual([
      { key: 'mayorista', source: 'BOT', createdById: null, removed: false },
    ]);
    const [delivery] = await prisma.webhookDelivery.findMany({
      where: { event: 'contact.tags_changed' },
    });
    expect(delivery?.payload).toMatchObject({
      data: {
        source: 'BOT',
        changedBy: null,
        tags: { before: [], after: [{ key: 'mayorista', name: 'Mayorista' }] },
        contact: { waId: USER },
      },
    });
  });

  it('never puts a PERSON tag, a tag of another business or one a person took off', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug');
    await tag('Mayorista', 'mayorista', 'BOT');
    await tag('VIP', 'vip', 'PERSON');
    const proveedor = await tag('Proveedor', 'proveedor', 'BOT');
    const other = await createLine(prisma, {
      slug: 'otro',
      phoneNumberId: '999',
    });
    await tag('Revendedor', 'revendedor', 'BOT', other.businessId);
    respond.mockResolvedValueOnce(text('¡Hola!'));
    await say('hola');
    const person = await prisma.user.create({
      data: { email: 'ana@example.com', name: 'Ana', passwordHash: 'x' },
    });
    await prisma.contactTagAssignment.create({
      data: {
        contactId: (await contact()).id,
        tagId: proveedor.id,
        source: 'BOT',
        removedAt: new Date(),
        removedById: person.id,
      },
    });
    const before = await assignments();

    respond
      .mockResolvedValueOnce(
        tool('tag_contact', {
          add: ['vip', 'revendedor', 'proveedor', 'no_existe'],
          remove: [],
        }),
      )
      .mockResolvedValueOnce(text('Dale, te cuento.'));
    await say('soy vip, revendedor y proveedor');

    expect(sendText.mock.calls.at(-1)?.[1]).toBe('Dale, te cuento.');
    expect(await assignments()).toEqual(before);
    expect(await prisma.webhookDelivery.count()).toBe(0);
    const ignored = debug.mock.calls
      .map(
        ([message]) => JSON.parse(String(message)) as Record<string, unknown>,
      )
      .filter((m) => m.event === 'tag_contact_ignored')
      .map((m) => [m.key, m.reason]);
    expect(ignored).toEqual([
      ['vip', 'person_only'],
      ['revendedor', 'unknown'],
      ['proveedor', 'removed_by_person'],
      ['no_existe', 'unknown'],
    ]);
    debug.mockRestore();
  });

  it('takes off only the tags it put', async () => {
    const mayorista = await tag('Mayorista', 'mayorista', 'BOT');
    const proveedor = await tag('Proveedor', 'proveedor', 'BOT');
    respond.mockResolvedValueOnce(text('¡Hola!'));
    await say('hola');
    const contactId = (await contact()).id;
    const person = await prisma.user.create({
      data: { email: 'ana@example.com', name: 'Ana', passwordHash: 'x' },
    });
    await prisma.contactTagAssignment.createMany({
      data: [
        { contactId, tagId: mayorista.id, source: 'BOT' },
        {
          contactId,
          tagId: proveedor.id,
          source: 'PERSON',
          createdById: person.id,
        },
      ],
    });

    respond
      .mockResolvedValueOnce(
        tool('tag_contact', { add: [], remove: ['mayorista', 'proveedor'] }),
      )
      .mockResolvedValueOnce(text('Entendido.'));
    await say('no soy mayorista ni proveedor');

    expect(await assignments()).toEqual([
      {
        key: 'proveedor',
        source: 'PERSON',
        createdById: person.id,
        removed: false,
      },
    ]);
  });
});
