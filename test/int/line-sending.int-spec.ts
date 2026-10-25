import { AdminService } from '../../src/admin/admin.service.js';
import { EchoReplyGenerator } from '../../src/bot/reply-generator.js';
import { BotWorker } from '../../src/bot/worker.js';
import { ContextService } from '../../src/conversations/context.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { QueueSignal } from '../../src/queue/queue-signal.js';
import { QueueService } from '../../src/queue/queue.service.js';
import type {
  SendOutcome,
  WhatsAppClient,
  WhatsAppClientFactory,
} from '../../src/whatsapp/whatsapp.client.js';
import {
  buildBotService,
  connectPrisma,
  createLine,
  resetDb,
  testConfig,
  textEvent,
} from './helpers.js';

const USER = '5491100001234';

describe('Sending from the conversation line (integration)', () => {
  const config = testConfig();
  let prisma: PrismaService;
  let conversations: ConversationsService;
  /** One client per line, so each send records which line sent it. */
  const sent: Array<{ lineId: string | null; to: string; body: string }> = [];
  const factory: WhatsAppClientFactory = {
    forLine: (lineId) =>
      Promise.resolve<WhatsAppClient>({
        sendText: (to, body) => {
          sent.push({ lineId, to, body });
          return Promise.resolve<SendOutcome>({
            kind: 'sent',
            waMessageId: `wamid.out.${sent.length}`,
          });
        },
      }),
  };

  beforeAll(async () => {
    prisma = await connectPrisma(config);
    conversations = new ConversationsService(prisma, config, new QueueSignal());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    sent.length = 0;
  });

  it("the bot replies from the inbound message's line to its contact", async () => {
    const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });
    const b = await createLine(prisma, { slug: 'b', phoneNumberId: '222' });
    const worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      buildBotService(prisma, factory, new EchoReplyGenerator()),
      new QueueSignal(),
    );

    await conversations.recordInbound(textEvent('wamid.a', USER, 'hola a'), a);
    await conversations.recordInbound(textEvent('wamid.b', USER, 'hola b'), b);
    await worker.drain();

    expect(sent).toHaveLength(2);
    expect(sent.find((s) => s.body.includes('hola a'))).toMatchObject({
      lineId: a.lineId,
      to: USER,
    });
    expect(sent.find((s) => s.body.includes('hola b'))).toMatchObject({
      lineId: b.lineId,
      to: USER,
    });
  });

  it("a human reply goes out from the conversation's line", async () => {
    const b = await createLine(prisma, { slug: 'b', phoneNumberId: '222' });
    const result = await conversations.recordInbound(
      { ...textEvent('wamid.b', USER), timestamp: new Date() },
      b,
    );
    if (result.outcome !== 'created') {
      throw new Error('inbound not stored');
    }
    const admin = new AdminService(prisma, new ContextService(prisma), factory);

    const reply = await admin.sendHumanReply(result.conversationId, 'Hola!');

    expect(reply.outcome).toBe('sent');
    expect(sent).toEqual([{ lineId: b.lineId, to: USER, body: 'Hola!' }]);
  });

  it("a status for another line's message changes nothing", async () => {
    const a = await createLine(prisma, { slug: 'a', phoneNumberId: '111' });
    const b = await createLine(prisma, { slug: 'b', phoneNumberId: '222' });
    const worker = new BotWorker(
      config,
      new QueueService(prisma, config),
      buildBotService(prisma, factory, new EchoReplyGenerator()),
      new QueueSignal(),
    );
    await conversations.recordInbound(textEvent('wamid.b', USER), b);
    await worker.drain();
    const outbound = await prisma.message.findFirstOrThrow({
      where: { direction: 'OUTBOUND' },
    });

    // Line A's own phone id, but the wamid of line B's message.
    await conversations.ingest(
      [
        {
          kind: 'status',
          phoneNumberId: '111',
          waMessageId: outbound.waMessageId!,
          status: 'read',
          recipientId: USER,
          timestamp: new Date(),
        },
      ],
      { ...a, phoneNumberId: '111' },
    );

    const after = await prisma.message.findUniqueOrThrow({
      where: { id: outbound.id },
    });
    expect(after.status).toBe('SENT');
  });
});
