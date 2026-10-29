import { QueueSignal } from '../../src/queue/queue-signal.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { StatusUpdate } from '../../src/whatsapp/inbound-event.js';
import {
  connectPrisma,
  resetDb,
  testConfig,
  textEvent,
  DEFAULT_PHONE_NUMBER_ID,
} from './helpers.js';

describe('ConversationsService (integration)', () => {
  let prisma: PrismaService;
  let service: ConversationsService;

  beforeAll(async () => {
    prisma = await connectPrisma();
    service = new ConversationsService(prisma, testConfig(), new QueueSignal());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  describe('recordInbound', () => {
    it('creates conversation, active commercial context, message and job', async () => {
      const result = await service.recordInbound(textEvent('wamid.1'));

      expect(result.outcome).toBe('created');
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { contact: { waId: '5491100001234' } },
        include: { contexts: true },
      });
      expect(conversation).toMatchObject({
        mode: 'COMMERCIAL',
        paused: false,
        lastInboundAt: new Date('2026-10-11T12:00:00Z'),
      });
      expect(conversation.contexts).toHaveLength(1);
      expect(conversation.contexts[0]).toMatchObject({
        mode: 'COMMERCIAL',
        endedAt: null,
      });
      expect(conversation.activeContextId).toBe(conversation.contexts[0]!.id);

      const message = await prisma.message.findUniqueOrThrow({
        where: { waMessageId: 'wamid.1' },
        include: { processingJob: true },
      });
      expect(message).toMatchObject({
        conversationId: conversation.id,
        contextId: conversation.activeContextId,
        direction: 'INBOUND',
        type: 'TEXT',
        content: 'hola',
        status: 'RECEIVED',
        author: 'USER',
      });
      expect(message.processingJob).toMatchObject({
        type: 'INBOUND_MESSAGE',
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 3,
        conversationId: conversation.id,
      });
    });

    it('stores unsupported messages with a type marker', async () => {
      await service.recordInbound({
        kind: 'unsupported',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        waMessageId: 'wamid.img',
        from: '5491100001234',
        timestamp: new Date(),
        messageType: 'image',
      });

      const message = await prisma.message.findUniqueOrThrow({
        where: { waMessageId: 'wamid.img' },
      });
      expect(message).toMatchObject({
        type: 'UNSUPPORTED',
        content: '[image]',
      });
    });

    it('stores an attachment with its media columns, its caption as content and the contact name', async () => {
      await service.recordInbound({
        kind: 'unsupported',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        waMessageId: 'wamid.photo',
        from: '5491100001234',
        timestamp: new Date(),
        messageType: 'image',
        profileName: 'Ana',
        media: {
          kind: 'image',
          mediaId: 'media-9',
          mime: 'image/jpeg',
          size: 1234,
          caption: '¿Tienen esta?',
        },
      });
      await service.recordInbound({
        kind: 'unsupported',
        phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
        waMessageId: 'wamid.voice',
        from: '5491100001234',
        timestamp: new Date(),
        messageType: 'audio',
        media: {
          kind: 'audio',
          mediaId: 'media-10',
          mime: 'audio/ogg',
          voice: true,
        },
      });

      const photo = await prisma.message.findUniqueOrThrow({
        where: { waMessageId: 'wamid.photo' },
      });
      expect(photo).toMatchObject({
        type: 'UNSUPPORTED',
        content: '¿Tienen esta?',
        mediaKind: 'image',
        mediaId: 'media-9',
        mediaMime: 'image/jpeg',
        mediaSize: 1234,
        mediaVoice: null,
        transcript: null,
        mediaError: null,
      });
      expect(
        await prisma.message.findUniqueOrThrow({
          where: { waMessageId: 'wamid.voice' },
        }),
      ).toMatchObject({
        content: '[audio]',
        mediaKind: 'audio',
        mediaVoice: true,
      });
      expect((await prisma.contact.findFirstOrThrow()).profileName).toBe('Ana');
    });

    it('stores a location as text with its media kind', async () => {
      await service.recordInbound({
        ...textEvent('wamid.loc', '5491100001234', 'Ubicación: KUBBO (1, 2)'),
        media: { kind: 'location' },
      });

      expect(
        await prisma.message.findUniqueOrThrow({
          where: { waMessageId: 'wamid.loc' },
        }),
      ).toMatchObject({
        type: 'TEXT',
        content: 'Ubicación: KUBBO (1, 2)',
        mediaKind: 'location',
        mediaId: null,
      });
    });

    it('reuses the conversation and its context for later messages', async () => {
      await service.recordInbound(textEvent('wamid.1'));
      await service.recordInbound({
        ...textEvent('wamid.2'),
        timestamp: new Date('2026-10-11T13:00:00Z'),
      });
      // An older (late) delivery never moves the 24h window backwards.
      await service.recordInbound({
        ...textEvent('wamid.0'),
        timestamp: new Date('2026-10-11T08:00:00Z'),
      });

      expect(await prisma.conversation.count()).toBe(1);
      expect(await prisma.conversationContext.count()).toBe(1);
      expect(await prisma.processingJob.count()).toBe(3);
      const conversation = await prisma.conversation.findFirstOrThrow();
      expect(conversation.lastInboundAt).toEqual(
        new Date('2026-10-11T13:00:00Z'),
      );
    });

    it('ignores a duplicated message id: one message, one job', async () => {
      const first = await service.recordInbound(textEvent('wamid.dup'));
      const second = await service.recordInbound(textEvent('wamid.dup'));

      expect(first.outcome).toBe('created');
      expect(second.outcome).toBe('duplicate');
      expect(await prisma.message.count()).toBe(1);
      expect(await prisma.processingJob.count()).toBe(1);
    });

    it('is race-safe under concurrent duplicate deliveries', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          service.recordInbound(textEvent('wamid.race')),
        ),
      );

      expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
      expect(await prisma.conversation.count()).toBe(1);
      expect(await prisma.conversationContext.count()).toBe(1);
      expect(await prisma.message.count()).toBe(1);
      expect(await prisma.processingJob.count()).toBe(1);
    });

    it('creates one conversation for concurrent first messages of a new user', async () => {
      await Promise.all(
        ['wamid.a', 'wamid.b', 'wamid.c'].map((id) =>
          service.recordInbound(textEvent(id)),
        ),
      );

      expect(await prisma.conversation.count()).toBe(1);
      expect(await prisma.conversationContext.count()).toBe(1);
      expect(await prisma.processingJob.count()).toBe(3);
    });
  });

  describe('applyStatus', () => {
    async function seedOutbound(status: 'SENT' | 'DELIVERED' | 'READ') {
      await service.recordInbound(textEvent('wamid.in'));
      const conversation = await prisma.conversation.findFirstOrThrow();
      return prisma.message.create({
        data: {
          conversationId: conversation.id,
          contextId: conversation.activeContextId,
          waMessageId: 'wamid.out',
          direction: 'OUTBOUND',
          type: 'TEXT',
          content: 'reply',
          status,
          author: 'BOT',
        },
      });
    }

    const statusEvent = (
      status: string,
      errors?: StatusUpdate['errors'],
    ): StatusUpdate => ({
      kind: 'status',
      phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
      waMessageId: 'wamid.out',
      status,
      recipientId: '5491100001234',
      timestamp: new Date(),
      ...(errors ? { errors } : {}),
    });

    const outboundStatus = async () =>
      (
        await prisma.message.findUniqueOrThrow({
          where: { waMessageId: 'wamid.out' },
        })
      ).status;

    it('moves forward SENT → DELIVERED → READ and never creates jobs', async () => {
      await seedOutbound('SENT');
      const jobsBefore = await prisma.processingJob.count();

      expect(await service.applyStatus(statusEvent('delivered'))).toBe(
        'updated',
      );
      expect(await outboundStatus()).toBe('DELIVERED');
      expect(await service.applyStatus(statusEvent('read'))).toBe('updated');
      expect(await outboundStatus()).toBe('READ');

      expect(await prisma.processingJob.count()).toBe(jobsBefore);
    });

    it('never moves backwards on out-of-order statuses', async () => {
      await seedOutbound('READ');

      expect(await service.applyStatus(statusEvent('delivered'))).toBe(
        'ignored',
      );
      expect(await service.applyStatus(statusEvent('sent'))).toBe('ignored');
      expect(await service.applyStatus(statusEvent('failed'))).toBe('ignored');
      expect(await outboundStatus()).toBe('READ');
    });

    it('records FAILED with the error code from a non-final status', async () => {
      await seedOutbound('DELIVERED');

      await service.applyStatus(statusEvent('failed', [{ code: 131047 }]));

      const message = await prisma.message.findUniqueOrThrow({
        where: { waMessageId: 'wamid.out' },
      });
      expect(message).toMatchObject({ status: 'FAILED', errorCode: '131047' });
    });

    it('ignores unknown message ids and unknown status values', async () => {
      await seedOutbound('SENT');

      expect(
        await service.applyStatus({ ...statusEvent('read'), waMessageId: 'x' }),
      ).toBe('ignored');
      expect(await service.applyStatus(statusEvent('deleted'))).toBe('ignored');
      expect(await outboundStatus()).toBe('SENT');
    });

    it('never applies a status to an inbound message', async () => {
      await service.recordInbound(textEvent('wamid.user'));

      await service.applyStatus({
        ...statusEvent('read'),
        waMessageId: 'wamid.user',
      });

      const inbound = await prisma.message.findUniqueOrThrow({
        where: { waMessageId: 'wamid.user' },
      });
      expect(inbound.status).toBe('RECEIVED');
    });
  });
});
