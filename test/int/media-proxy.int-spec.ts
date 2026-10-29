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
import {
  MEDIA_SOURCE,
  type MediaSource,
} from '../../src/media/line-media.service.js';
import { signedMediaPath } from '../../src/media/media-url.js';
import { MediaFetchError } from '../../src/media/meta-media.client.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { InboundMedia } from '../../src/whatsapp/inbound-event.js';
import { createLine, DEFAULT_PHONE_NUMBER_ID, resetDb } from './helpers.js';

const PASSWORD = 'una clave larga';
const SECRET = 'int-media-secret-0123456789abcdef01234567';
const META_URL = 'https://lookaside.fbsbx.com/x';

describe('Inbox attachments: messages API and media proxy (integration, HTTP)', () => {
  const info = vi.fn<MediaSource['info']>();
  const open = vi.fn<MediaSource['open']>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let b: string;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MEDIA_SOURCE)
      .useValue({
        info,
        open,
        download: () => Promise.reject(new Error('not used')),
      } satisfies MediaSource)
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue(new InMemoryLoginRateLimiter({ max: 1000, windowMs: 60_000 }))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    info.mockReset();
    open.mockReset();
    info.mockResolvedValue({
      url: META_URL,
      mimeType: 'audio/ogg',
      fileSize: 5,
    });
    open.mockImplementation((_line, _url, range) =>
      Promise.resolve(
        range
          ? new Response('ab', {
              status: 206,
              headers: {
                'content-type': 'audio/ogg',
                'content-range': 'bytes 0-1/5',
                'content-length': '2',
                'accept-ranges': 'bytes',
              },
            })
          : new Response('abcde', {
              headers: { 'content-type': 'audio/ogg', 'content-length': '5' },
            }),
      ),
    );
    b = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    await app.get(UsersService).addToBusiness(b, {
      email: 'olga@example.com',
      name: 'Olga',
      password: PASSWORD,
      role: 'OWNER',
    });
  });

  const http = () => request(app.getHttpServer());
  const receive = async (media: InboundMedia, caption?: string) => {
    const waMessageId = `wamid.m.${(seq += 1)}`;
    await conversations.recordInbound({
      kind: 'unsupported',
      phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
      waMessageId,
      from: '5491100001234',
      timestamp: new Date(),
      messageType: media.kind,
      media: { ...media, ...(caption ? { caption } : {}) },
    });
    return prisma.message.findUniqueOrThrow({ where: { waMessageId } });
  };
  const audio = (mime = 'audio/ogg; codecs=opus') =>
    receive({ kind: 'audio', mediaId: 'media-1', mime, voice: true });

  it('the messages API carries the attachment with a signed link', async () => {
    const message = await audio();
    await prisma.message.update({
      where: { id: message.id },
      data: { transcript: 'hola, quiero un kilo' },
    });
    await receive(
      { kind: 'image', mediaId: 'media-2', mime: 'image/jpeg' },
      '¿Tienen esta?',
    );
    const login = await http()
      .post('/auth/login')
      .send({ email: 'olga@example.com', password: PASSWORD })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])
      .find((l) => l.startsWith('bottega_session='))!
      .split(';')[0]!;

    const res = await http()
      .get(
        `/inbox/businesses/${b}/conversations/${message.conversationId}/messages`,
      )
      .set('Cookie', cookie)
      .expect(200);

    const [voice, image] = (
      res.body as { messages: { media: Record<string, unknown> | null }[] }
    ).messages;
    expect(voice?.media).toEqual({
      kind: 'audio',
      mime: 'audio/ogg; codecs=opus',
      filename: null,
      caption: null,
      voice: true,
      transcript: 'hola, quiero un kilo',
      error: null,
      url: expect.stringMatching(
        new RegExp(
          `^/inbox/businesses/${b}/media/${message.id}\\?exp=\\d+&sig=`,
        ),
      ) as unknown,
    });
    expect(image?.media).toMatchObject({
      kind: 'image',
      caption: '¿Tienen esta?',
    });
  });

  it('streams the file with its type and the safety headers', async () => {
    const message = await audio();

    const res = await http()
      .get(signedMediaPath(SECRET, b, message.id))
      .expect(200);

    expect(res.headers['content-type']).toBe('audio/ogg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(Buffer.from(res.body as Buffer).toString()).toBe('abcde');
    expect(info).toHaveBeenCalledWith(expect.any(String), 'media-1');
  });

  it('passes a range on and answers 206', async () => {
    const message = await audio();

    const res = await http()
      .get(signedMediaPath(SECRET, b, message.id))
      .set('Range', 'bytes=0-1')
      .expect(206);

    expect(open.mock.calls[0]?.[2]).toBe('bytes=0-1');
    expect(res.headers['content-range']).toBe('bytes 0-1/5');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('serves a file of any other type as a download', async () => {
    const message = await receive({
      kind: 'document',
      mediaId: 'media-9',
      mime: 'text/html',
      filename: 'x.html',
    });

    const res = await http()
      .get(signedMediaPath(SECRET, b, message.id))
      .expect(200);

    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('403 for a bad or expired signature, 404 for another business, 410 when Meta deleted it', async () => {
    const message = await audio();
    const path = signedMediaPath(SECRET, b, message.id);

    await http()
      .get(path.replace(/sig=[^&]+/, 'sig=AAAA'))
      .expect(403);
    await http()
      .get(path.replace(/exp=\d+/, 'exp=1'))
      .expect(403);
    await http().get(`/inbox/businesses/${b}/media/${message.id}`).expect(403);
    const expired = signedMediaPath(
      SECRET,
      b,
      message.id,
      new Date(Date.now() - 2 * 60 * 60_000),
    );
    await http().get(expired).expect(403);

    // Correctly signed for another business: the message is not theirs.
    const other = (
      await createLine(prisma, { slug: 'otro', phoneNumberId: '333' })
    ).businessId;
    await http()
      .get(signedMediaPath(SECRET, other, message.id))
      .expect(404);
    expect(info).not.toHaveBeenCalled();

    info.mockRejectedValueOnce(new MediaFetchError('media_gone', false));
    await http().get(path).expect(410);
  });
});
