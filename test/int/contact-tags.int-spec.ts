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
import { BusinessModulesService } from '../../src/bot/business-modules.service.js';
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ContactTagsService } from '../../src/contacts/contact-tags.service.js';
import { ConversationsService } from '../../src/conversations/conversations.service.js';
import { LineCredentialsService } from '../../src/lines/line-credentials.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb, textEvent } from './helpers.js';

const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const USER = '5491100001234';

const RETAIL = 'codigo;producto;precio\nC1;Cucurucho;3000';
const WHOLESALE =
  'codigo;producto;precio\nM1;Caja mayorista de cucuruchos;20000';

type TagBody = {
  id: string;
  name: string;
  key: string;
  assignedBy: 'BOT' | 'PERSON';
  botHint: string | null;
  color: string;
};
type CatalogBody = {
  id: string;
  name: string;
  audience: 'ALL' | 'TAGGED';
  replacesAll: boolean;
  tagIds: string[];
};
type Chip = {
  id: string;
  name: string;
  color: string;
  source: 'BOT' | 'PERSON';
};
type Conversation = {
  id: string;
  version: number;
  contact: { id: string; tags: Chip[] };
};

describe('Contact tags and catalog audience (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let catalog: CatalogService;
  let a: string;
  let lineA: string;
  let b: string;
  let seq = 0;
  let owner: string;
  let agent: string;
  let otherOwner: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue(new InMemoryLoginRateLimiter({ max: 1000, windowMs: 60_000 }))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    catalog = app.get(CatalogService);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const sessionOf = async (email: string) => {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };

  beforeEach(async () => {
    await resetDb(prisma);
    const line = await createLine(prisma, {
      slug: 'kubbo',
      phoneNumberId: '222',
    });
    a = line.businessId;
    lineA = line.lineId;
    b = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
    const users = app.get(UsersService);
    for (const [email, role, business] of [
      ['olga@example.com', 'OWNER', a],
      ['ana@example.com', 'AGENT', a],
      ['bruno@example.com', 'OWNER', b],
    ] as const) {
      await users.addToBusiness(business, {
        email,
        name: email,
        password: PASSWORD,
        role,
      });
    }
    owner = await sessionOf('olga@example.com');
    agent = await sessionOf('ana@example.com');
    otherOwner = await sessionOf('bruno@example.com');
  });

  const tagsUrl = (business = a) =>
    `/inbox/businesses/${business}/settings/contact-tags`;
  const createTag = async (
    body: Record<string, unknown>,
    cookie = owner,
    business = a,
  ) =>
    (
      await http()
        .post(tagsUrl(business))
        .set('Cookie', cookie)
        .send(body)
        .expect(201)
    ).body as TagBody;
  const mayorista = () =>
    createTag({
      name: 'Mayorista',
      assignedBy: 'PERSON',
      color: 'blue',
    });

  /** A conversation of `from` on the line (the business's own by default). */
  const inbound = async (
    from = USER,
    line: { lineId: string; businessId: string } = {
      lineId: lineA,
      businessId: a,
    },
  ) => {
    const result = await app
      .get(ConversationsService)
      .recordInbound(
        { ...textEvent(`wamid.tags.${(seq += 1)}`, from, 'hola') },
        line,
      );
    if (result.outcome !== 'created') {
      throw new Error(`inbound not recorded: ${result.outcome}`);
    }
    return prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
    });
  };

  const putTags = (contactId: string, tagIds: string[], cookie = owner) =>
    http()
      .put(`/inbox/businesses/${a}/contacts/${contactId}/tags`)
      .set('Cookie', cookie)
      .send({ tagIds });

  const createCatalog = async (name: string) =>
    (
      await http()
        .post(`/admin/businesses/${a}/catalogs`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name })
        .expect(201)
    ).body as CatalogBody;
  const importInto = async (catalogId: string, csv: string) => {
    const base = `/admin/businesses/${a}/catalogs/${catalogId}/imports`;
    const preview = (
      await http()
        .post(base)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .set('Content-Type', 'text/csv')
        .send(csv)
        .expect(201)
    ).body as { id: string };
    await http()
      .post(`${base}/${preview.id}/apply`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);
  };
  const patchCatalog = (catalogId: string, body: unknown, cookie = owner) =>
    http()
      .patch(`/inbox/businesses/${a}/settings/catalogs/${catalogId}`)
      .set('Cookie', cookie)
      .send(body as object);

  /** Retail (ALL) and wholesale catalogs, with an item each. */
  const twoCatalogs = async () => {
    const retail = await createCatalog('Minorista');
    const wholesale = await createCatalog('Mayorista');
    await importInto(retail.id, RETAIL);
    await importInto(wholesale.id, WHOLESALE);
    return { retail, wholesale };
  };
  const searchAs = async (contactId: string | null, query: string) =>
    (
      await catalog.search(
        a,
        { query, category: null, maxPrice: null },
        contactId,
      )
    ).map((i) => i.name);

  describe('tag settings', () => {
    it('an OWNER creates, lists, renames and deletes tags; the key stays', async () => {
      const tag = await createTag({
        name: '  Revendedor  Mayorista ',
        assignedBy: 'BOT',
        botHint: 'Compra por cantidad para revender o pide precio por bulto',
        color: 'green',
      });
      expect(tag).toMatchObject({
        name: 'Revendedor Mayorista',
        key: 'revendedor_mayorista',
        assignedBy: 'BOT',
        botHint: 'Compra por cantidad para revender o pide precio por bulto',
        color: 'green',
      });

      const renamed = (
        await http()
          .patch(`${tagsUrl()}/${tag.id}`)
          .set('Cookie', owner)
          .send({ name: 'Revendedor', color: 'red' })
          .expect(200)
      ).body as TagBody;
      expect(renamed).toMatchObject({
        name: 'Revendedor',
        key: 'revendedor_mayorista',
        color: 'red',
      });

      const list = (
        await http().get(tagsUrl()).set('Cookie', owner).expect(200)
      ).body as TagBody[];
      expect(list.map((t) => t.name)).toEqual(['Revendedor']);

      await http()
        .delete(`${tagsUrl()}/${tag.id}`)
        .set('Cookie', owner)
        .expect(200);
      expect(await prisma.contactTag.count()).toBe(0);
    });

    it('names are unique without case or accents, a cap holds and bad input is 400', async () => {
      await createTag({ name: 'Mayorísta', assignedBy: 'PERSON' });
      const taken = await http()
        .post(tagsUrl())
        .set('Cookie', owner)
        .send({ name: 'mayorista', assignedBy: 'PERSON' })
        .expect(409);
      expect(taken.body).toMatchObject({ code: 'CONTACT_TAG_NAME_TAKEN' });

      for (const body of [
        { name: '', assignedBy: 'BOT' },
        { name: 'x'.repeat(41), assignedBy: 'BOT' },
        { name: 'VIP', assignedBy: 'PERSON', botHint: 'nunca' },
        { name: 'VIP', assignedBy: 'BOT', botHint: 'x'.repeat(301) },
        { name: 'VIP', assignedBy: 'BOT', color: 'fucsia-neon' },
        { name: 'VIP', assignedBy: 'NADIE' },
      ]) {
        await http()
          .post(tagsUrl())
          .set('Cookie', owner)
          .send(body)
          .expect(400);
      }

      await prisma.contactTag.createMany({
        data: Array.from({ length: 29 }, (_, i) => ({
          businessId: a,
          name: `T${i}`,
          nameKey: `t${i}`,
          key: `t${i}`,
          assignedBy: 'PERSON' as const,
          color: 'gray',
        })),
      });
      const full = await http()
        .post(tagsUrl())
        .set('Cookie', owner)
        .send({ name: 'Una más', assignedBy: 'PERSON' })
        .expect(409);
      expect(full.body).toMatchObject({ code: 'CONTACT_TAG_LIMIT_REACHED' });
      expect(await prisma.contactTag.count({ where: { businessId: a } })).toBe(
        30,
      );
    });

    it('two names with the same key get different keys', async () => {
      const first = await createTag({ name: 'Mayorista', assignedBy: 'BOT' });
      const second = await createTag({ name: 'Mayorista!', assignedBy: 'BOT' });
      expect([first.key, second.key]).toEqual(['mayorista', 'mayorista_2']);
    });

    it('an AGENT gets 403 and a tag of another business is 404', async () => {
      await http().get(tagsUrl()).set('Cookie', agent).expect(403);
      await http()
        .post(tagsUrl())
        .set('Cookie', agent)
        .send({ name: 'VIP', assignedBy: 'PERSON' })
        .expect(403);
      const theirs = await createTag(
        { name: 'VIP', assignedBy: 'PERSON' },
        otherOwner,
        b,
      );
      await http()
        .patch(`${tagsUrl()}/${theirs.id}`)
        .set('Cookie', owner)
        .send({ name: 'Mío' })
        .expect(404);
      await http()
        .delete(`${tagsUrl()}/${theirs.id}`)
        .set('Cookie', owner)
        .expect(404);
      expect(
        await prisma.contactTag.findUniqueOrThrow({ where: { id: theirs.id } }),
      ).toMatchObject({ name: 'VIP' });
    });

    it('deleting a tag a catalog uses is 409 TAG_IN_USE with the catalogs', async () => {
      const tag = await mayorista();
      const { wholesale } = await twoCatalogs();
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [tag.id],
      }).expect(200);

      const res = await http()
        .delete(`${tagsUrl()}/${tag.id}`)
        .set('Cookie', owner)
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'TAG_IN_USE',
        catalogs: [{ id: wholesale.id, name: 'Mayorista' }],
      });
      expect(await prisma.contactTag.count()).toBe(1);
    });
  });

  describe('tags of a contact', () => {
    it('PUT replaces them: added ones are PERSON, taken off ones keep removed_at', async () => {
      const vip = await createTag({ name: 'VIP', assignedBy: 'PERSON' });
      const wholesaler = await mayorista();
      const conversation = await inbound();
      const contactId = conversation.contactId;

      const put = await putTags(contactId, [vip.id, wholesaler.id], agent);
      expect(put.status).toBe(200);
      expect(put.body).toEqual({
        tags: [
          {
            id: wholesaler.id,
            name: 'Mayorista',
            color: 'blue',
            source: 'PERSON',
          },
          { id: vip.id, name: 'VIP', color: 'gray', source: 'PERSON' },
        ],
      });
      const ana = await prisma.user.findUniqueOrThrow({
        where: { email: 'ana@example.com' },
      });
      expect(
        await prisma.contactTagAssignment.findMany({
          where: { contactId },
          orderBy: { tag: { name: 'asc' } },
        }),
      ).toMatchObject([
        { tagId: wholesaler.id, source: 'PERSON', createdById: ana.id },
        { tagId: vip.id, source: 'PERSON', createdById: ana.id },
      ]);

      await putTags(contactId, [vip.id]).expect(200);
      const olga = await prisma.user.findUniqueOrThrow({
        where: { email: 'olga@example.com' },
      });
      const removed = await prisma.contactTagAssignment.findUniqueOrThrow({
        where: { contactId_tagId: { contactId, tagId: wholesaler.id } },
      });
      expect(removed.removedAt).not.toBeNull();
      expect(removed.removedById).toBe(olga.id);

      // A person may put it back.
      await putTags(contactId, [vip.id, wholesaler.id]).expect(200);
      expect(
        await prisma.contactTagAssignment.findUniqueOrThrow({
          where: { contactId_tagId: { contactId, tagId: wholesaler.id } },
        }),
      ).toMatchObject({ removedAt: null, removedById: null, source: 'PERSON' });
    });

    it('a person and the bot tagging the same contact at once never deadlock', async () => {
      const vip = await createTag({ name: 'VIP', assignedBy: 'PERSON' });
      const reseller = await createTag({
        name: 'Revendedor',
        assignedBy: 'BOT',
        botHint: 'Compra para revender',
      });
      const conversation = await inbound();
      const tags = app.get(ContactTagsService);
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));

      // A bot turn: it holds its conversation before tagging (as the worker).
      const bot = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM conversation WHERE id = ${conversation.id}::uuid FOR UPDATE`;
          locked();
          await gate;
          await tags.applyFromBot(tx, conversation.id, {
            add: [reseller.key],
            remove: [],
          });
        },
        { timeout: 15_000 },
      );
      await isLocked;
      const person = putTags(conversation.contactId, [vip.id]).then(
        (res) => res.status,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();

      const [, status] = await Promise.all([bot, person]);
      expect(status).toBe(200);
      // The person's PUT waited for the bot's turn and replaced its tags.
      const rows = await prisma.contactTagAssignment.findMany({
        where: { contactId: conversation.contactId },
        include: { tag: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        rows.map((r) => [r.tag.name, r.source, r.removedAt !== null]),
      ).toEqual([
        ['Revendedor', 'BOT', true],
        ['VIP', 'PERSON', false],
      ]);
    });

    it('each tag of a conversation says who put it: the bot or a person', async () => {
      const vip = await createTag({ name: 'VIP', assignedBy: 'PERSON' });
      const reseller = await createTag({
        name: 'Revendedor',
        assignedBy: 'BOT',
        botHint: 'Compra para revender',
      });
      const conversation = await inbound();
      await prisma.$transaction((tx) =>
        app.get(ContactTagsService).applyFromBot(tx, conversation.id, {
          add: [reseller.key],
          remove: [],
        }),
      );
      await putTags(conversation.contactId, [vip.id, reseller.id]).expect(200);

      const detail = (
        await http()
          .get(`/inbox/businesses/${a}/conversations/${conversation.id}`)
          .set('Cookie', owner)
          .expect(200)
      ).body as Conversation;
      expect(detail.contact.tags).toEqual([
        { id: reseller.id, name: 'Revendedor', color: 'gray', source: 'BOT' },
        { id: vip.id, name: 'VIP', color: 'gray', source: 'PERSON' },
      ]);
    });

    it('a contact or a tag of another business is 404 and changes nothing', async () => {
      const tag = await mayorista();
      const theirs = await inbound(USER, {
        lineId: (
          await prisma.line.findFirstOrThrow({ where: { businessId: b } })
        ).id,
        businessId: b,
      });
      await putTags(theirs.contactId, [tag.id]).expect(404);

      const mine = await inbound();
      const theirTag = await createTag(
        { name: 'VIP', assignedBy: 'PERSON' },
        otherOwner,
        b,
      );
      await putTags(mine.contactId, [tag.id, theirTag.id]).expect(404);
      await putTags(mine.contactId, ['not-a-uuid']).expect(400);
      expect(await prisma.contactTagAssignment.count()).toBe(0);
    });

    it('conversations carry contact.tags in the list and changes, and filter by ?tagId=', async () => {
      const tag = await mayorista();
      const tagged = await inbound();
      const other = await inbound('5491100009999');
      const list = async (query = '') =>
        (
          await http()
            .get(`/inbox/businesses/${a}/conversations?view=unassigned${query}`)
            .set('Cookie', agent)
            .expect(200)
        ).body as { conversations: Conversation[] };

      expect((await list()).conversations.map((c) => c.contact.tags)).toEqual([
        [],
        [],
      ]);
      const changes = (
        await http()
          .get(`/inbox/businesses/${a}/changes`)
          .set('Cookie', agent)
          .expect(200)
      ).body as { cursor: string };

      await putTags(tagged.contactId, [tag.id]).expect(200);

      const filtered = await list(`&tagId=${tag.id}`);
      expect(filtered.conversations).toHaveLength(1);
      expect(filtered.conversations[0]).toMatchObject({
        id: tagged.id,
        contact: {
          id: tagged.contactId,
          tags: [
            { id: tag.id, name: 'Mayorista', color: 'blue', source: 'PERSON' },
          ],
        },
      });
      const since = (
        await http()
          .get(`/inbox/businesses/${a}/changes?cursor=${changes.cursor}`)
          .set('Cookie', agent)
          .expect(200)
      ).body as { conversations: Conversation[] };
      expect(since.conversations.map((c) => c.id)).toEqual([tagged.id]);
      expect(since.conversations[0]!.version).toBeGreaterThan(tagged.version);
      expect(since.conversations[0]!.contact.tags).toEqual([
        { id: tag.id, name: 'Mayorista', color: 'blue', source: 'PERSON' },
      ]);
      expect(other.id).not.toBe(tagged.id);

      const detail = (
        await http()
          .get(`/inbox/businesses/${a}/conversations/${tagged.id}`)
          .set('Cookie', agent)
          .expect(200)
      ).body as Conversation;
      expect(detail.contact.tags).toEqual([
        { id: tag.id, name: 'Mayorista', color: 'blue', source: 'PERSON' },
      ]);

      const theirs = await createTag(
        { name: 'VIP', assignedBy: 'PERSON' },
        otherOwner,
        b,
      );
      await http()
        .get(
          `/inbox/businesses/${a}/conversations?view=unassigned&tagId=${theirs.id}`,
        )
        .set('Cookie', agent)
        .expect(404);
    });

    it('emits contact.tags_changed with the tags before and after', async () => {
      await prisma.webhookSubscription.create({
        data: {
          businessId: a,
          url: 'https://n8n.example.com/hook',
          secretEncrypted: app.get(LineCredentialsService).encrypt('whsec_x'),
          events: ['contact.tags_changed'],
        },
      });
      const vip = await createTag({ name: 'VIP', assignedBy: 'PERSON' });
      const wholesaler = await mayorista();
      const conversation = await inbound();

      await putTags(conversation.contactId, [vip.id]).expect(200);
      await putTags(conversation.contactId, [wholesaler.id]).expect(200);
      // The same tags again: nothing changed, no event.
      await putTags(conversation.contactId, [wholesaler.id]).expect(200);

      const deliveries = await prisma.webhookDelivery.findMany({
        where: { event: 'contact.tags_changed' },
        orderBy: { createdAt: 'asc' },
      });
      expect(deliveries).toHaveLength(2);
      expect(deliveries[1]!.payload).toMatchObject({
        type: 'contact.tags_changed',
        businessId: a,
        data: {
          source: 'PERSON',
          tags: {
            before: [{ id: vip.id, key: 'vip', name: 'VIP' }],
            after: [{ id: wholesaler.id, key: 'mayorista', name: 'Mayorista' }],
          },
          conversation: { id: conversation.id, lineId: lineA },
          contact: { waId: USER },
        },
      });
    });
  });

  describe('catalog audience', () => {
    it('PATCH sets audience, tags and replacesAll, and validates them', async () => {
      const tag = await mayorista();
      const { wholesale } = await twoCatalogs();

      const missingTags = await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
      }).expect(400);
      expect(missingTags.body).toMatchObject({ code: 'TAGGED_WITHOUT_TAGS' });
      await patchCatalog(wholesale.id, { replacesAll: true }).expect(400);
      await patchCatalog(wholesale.id, { tagIds: [tag.id] }).expect(400);
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [],
      }).expect(400);

      const updated = (
        await patchCatalog(wholesale.id, {
          audience: 'TAGGED',
          tagIds: [tag.id],
          replacesAll: true,
        }).expect(200)
      ).body as CatalogBody;
      expect(updated).toMatchObject({
        audience: 'TAGGED',
        replacesAll: true,
        tagIds: [tag.id],
      });

      // Back to everyone: no tags and no replacing.
      const back = (
        await http()
          .patch(`/admin/businesses/${a}/catalogs/${wholesale.id}`)
          .set('X-Admin-Api-Key', ADMIN_KEY)
          .send({ audience: 'ALL' })
          .expect(200)
      ).body as CatalogBody;
      expect(back).toMatchObject({
        audience: 'ALL',
        replacesAll: false,
        tagIds: [],
      });
      expect(await prisma.catalogTag.count()).toBe(0);

      const theirs = await createTag(
        { name: 'VIP', assignedBy: 'PERSON' },
        otherOwner,
        b,
      );
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [theirs.id],
      }).expect(404);
      await patchCatalog(
        wholesale.id,
        { audience: 'TAGGED', tagIds: [tag.id] },
        agent,
      ).expect(403);
    });

    it('a contact without tags never gets items of a TAGGED catalog, even by its exact name', async () => {
      const tag = await mayorista();
      const { wholesale } = await twoCatalogs();
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [tag.id],
      }).expect(200);
      const conversation = await inbound();

      for (const contactId of [conversation.contactId, null]) {
        expect(
          await searchAs(contactId, 'Caja mayorista de cucuruchos'),
        ).not.toContain('Caja mayorista de cucuruchos');
        expect(await searchAs(contactId, 'mayorista')).toEqual([]);
      }
      expect(await searchAs(conversation.contactId, 'cucurucho')).toEqual([
        'Cucurucho',
      ]);
    });

    it('with the tag the contact sees it; with replaces_all no longer the ALL ones; taking it off cuts access', async () => {
      const tag = await mayorista();
      const { wholesale } = await twoCatalogs();
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [tag.id],
      }).expect(200);
      const conversation = await inbound();
      await putTags(conversation.contactId, [tag.id]).expect(200);

      expect(
        (await searchAs(conversation.contactId, 'cucuruchos')).sort(),
      ).toEqual(['Caja mayorista de cucuruchos', 'Cucurucho']);

      await patchCatalog(wholesale.id, { replacesAll: true }).expect(200);
      expect(await searchAs(conversation.contactId, 'cucuruchos')).toEqual([
        'Caja mayorista de cucuruchos',
      ]);

      await putTags(conversation.contactId, []).expect(200);
      expect(await searchAs(conversation.contactId, 'cucuruchos')).toEqual([
        'Cucurucho',
      ]);
    });

    it('the tags hold in a new conversation of the same contact', async () => {
      const tag = await mayorista();
      const { wholesale } = await twoCatalogs();
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [tag.id],
        replacesAll: true,
      }).expect(200);
      const first = await inbound();
      await putTags(first.contactId, [tag.id]).expect(200);

      const secondLine = await prisma.line.create({
        data: {
          businessId: a,
          phoneNumberId: '333',
          verifyToken: 'verify-kubbo-2',
          webhookKey: 'key-kubbo-2'.padEnd(24, '0'),
        },
      });
      const second = await inbound(USER, {
        lineId: secondLine.id,
        businessId: a,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.contactId).toBe(first.contactId);

      const modules = await app
        .get(BusinessModulesService, { strict: false })
        .forBusiness(a, 'COMMERCIAL', {
          conversationId: second.id,
          messageId: '00000000-0000-0000-0000-000000000000',
        });
      const found = await modules.catalog!.search({
        query: 'cucuruchos',
        category: null,
        maxPrice: null,
      });
      expect(found.map((i) => i.name)).toEqual([
        'Caja mayorista de cucuruchos',
      ]);
    });

    it('search_catalog is offered only when a catalog the contact sees has an item', async () => {
      const tag = await mayorista();
      const wholesale = await createCatalog('Mayorista');
      await importInto(wholesale.id, WHOLESALE);
      await patchCatalog(wholesale.id, {
        audience: 'TAGGED',
        tagIds: [tag.id],
      }).expect(200);
      const conversation = await inbound();
      const modulesOf = () =>
        app
          .get(BusinessModulesService, { strict: false })
          .forBusiness(a, 'COMMERCIAL', {
            conversationId: conversation.id,
            messageId: '00000000-0000-0000-0000-000000000000',
          });

      expect((await modulesOf()).catalog).toBeUndefined();
      await putTags(conversation.contactId, [tag.id]).expect(200);
      expect((await modulesOf()).catalog).toBeDefined();
    });
  });
});
