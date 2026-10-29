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
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';

const CSV = [
  'codigo;producto;descripcion;categoria;precio;disponible;sabor',
  'H1;Chocolate amargo;Cacao 70%;Helados;$ 1.500,00;sí;intenso',
  'H2;Dulce de leche;El clásico;Helados;1400;si;',
  'H3;Limón;Al agua;Helados;1.300;1;',
  'T1;Torta helada;Para 8 personas;Postres;"9.000,50";disponible;',
].join('\n');

type ImportBody = {
  id: string;
  status: string;
  summary: Record<string, number>;
  errors: { row: number; message: string }[];
};

describe('Catalog (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let users: UsersService;
  let catalog: CatalogService;
  let a: string;
  let b: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGIN_RATE_LIMITER)
      .useValue(new InMemoryLoginRateLimiter({ max: 1000, windowMs: 60_000 }))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
    catalog = app.get(CatalogService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    a = (await createLine(prisma, { slug: 'kubbo', phoneNumberId: '222' }))
      .businessId;
    b = (
      await prisma.business.findUniqueOrThrow({ where: { slug: 'botsuite46' } })
    ).id;
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
  });

  const http = () => request(app.getHttpServer());
  const admin = (path: string, business = a) =>
    `/admin/businesses/${business}/catalog/${path}`;

  const sessionOf = async (email: string) => {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };

  const previewCsv = async (csv: string, business = a) =>
    (
      await http()
        .post(admin('imports', business))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .set('Content-Type', 'text/csv')
        .send(csv)
        .expect(201)
    ).body as ImportBody;

  const applyImport = (id: string, business = a) =>
    http()
      .post(admin(`imports/${id}/apply`, business))
      .set('X-Admin-Api-Key', ADMIN_KEY);

  const importCsv = async (csv: string, business = a) => {
    const preview = await previewCsv(csv, business);
    return (await applyImport(preview.id, business).expect(200))
      .body as ImportBody;
  };

  const items = () =>
    prisma.catalogItem.findMany({
      where: { businessId: a },
      orderBy: { externalId: 'asc' },
    });

  it('previews, then applies: normalized prices, availability and attributes', async () => {
    const preview = await previewCsv(CSV);
    expect(preview).toMatchObject({
      status: 'PREVIEW',
      summary: {
        created: 4,
        updated: 0,
        unchanged: 0,
        unavailable: 0,
        errors: 0,
      },
      errors: [],
    });
    expect(await prisma.catalogItem.count()).toBe(0);

    const applied = await applyImport(preview.id).expect(200);
    expect(applied.body).toMatchObject({ status: 'APPLIED' });

    const stored = await items();
    expect(
      stored.map((i) => [
        i.externalId,
        i.name,
        i.price?.toFixed(2),
        i.available,
      ]),
    ).toEqual([
      ['H1', 'Chocolate amargo', '1500.00', true],
      ['H2', 'Dulce de leche', '1400.00', true],
      ['H3', 'Limón', '1300.00', true],
      ['T1', 'Torta helada', '9000.50', true],
    ]);
    expect(stored[0]).toMatchObject({
      currency: 'ARS',
      category: 'Helados',
      attributes: { sabor: 'intenso' },
    });
    // The preview rows are gone once applied.
    expect(
      (
        await prisma.catalogImport.findUniqueOrThrow({
          where: { id: preview.id },
        })
      ).rows,
    ).toBeNull();
    await applyImport(preview.id).expect(409);
  });

  it('importing the same CSV twice creates no duplicates and does not touch updated_at', async () => {
    await importCsv(CSV);
    const before = await items();

    const second = await importCsv(CSV);

    expect(second.summary).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 4,
      unavailable: 0,
    });
    const after = await items();
    expect(after).toHaveLength(4);
    expect(after.map((i) => i.updatedAt)).toEqual(
      before.map((i) => i.updatedAt),
    );
  });

  it('an item missing from the source becomes unavailable and comes back when it reappears', async () => {
    await importCsv(CSV);
    const withoutLimon = CSV.split('\n')
      .filter((line) => !line.startsWith('H3;'))
      .join('\n');

    const second = await importCsv(withoutLimon);
    expect(second.summary).toMatchObject({ unavailable: 1, unchanged: 3 });
    const limon = () =>
      prisma.catalogItem.findFirstOrThrow({ where: { externalId: 'H3' } });
    expect((await limon()).available).toBe(false);
    expect(await prisma.catalogItem.count()).toBe(4);

    const third = await importCsv(CSV);
    expect(third.summary).toMatchObject({ updated: 1, unavailable: 0 });
    expect((await limon()).available).toBe(true);
  });

  it('applies more changes than one update batch, and a re-import then changes nothing', async () => {
    const csv = (price: number, available = 'sí') =>
      [
        'codigo,producto,precio,disponible,sabor',
        ...Array.from(
          { length: 1200 },
          (_, i) => `C${i},Producto ${i},${price + i},${available},"x, ${i}"`,
        ),
      ].join('\n');
    await importCsv(csv(100));

    const changed = await importCsv(csv(200, 'no'));
    expect(changed.summary).toMatchObject({ updated: 1200, unchanged: 0 });
    const stored = await items();
    expect(stored.every((i) => !i.available)).toBe(true);
    const c999 = stored.find((i) => i.externalId === 'C999');
    expect(c999?.price?.toFixed(2)).toBe('1199.00');
    expect(c999?.attributes).toEqual({ sabor: 'x, 999' });

    const again = await importCsv(csv(200, 'no'));
    expect(again.summary).toMatchObject({ updated: 0, unchanged: 1200 });
  });

  it('an invalid row does not stop the valid ones; its error is in the preview', async () => {
    const csv = [
      'codigo,producto,precio',
      'A1,Uno,100',
      'A2,Dos,consultar',
      'A3,,50',
      'A1,Repetido,10',
      'A4,Cuatro,400',
    ].join('\n');

    const preview = await previewCsv(csv);

    expect(preview.summary).toMatchObject({ created: 2, errors: 3 });
    expect(preview.errors).toEqual([
      { row: 3, message: 'Fila 3: el precio "consultar" no es un número.' },
      { row: 4, message: 'Fila 4: falta el nombre.' },
      {
        row: 5,
        message: 'Fila 5: el código "A1" está repetido en el archivo.',
      },
    ]);
    await applyImport(preview.id).expect(200);
    expect((await items()).map((i) => i.externalId)).toEqual(['A1', 'A4']);
  });

  it('going over the item cap gives 409 CATALOG_CAP_EXCEEDED and applies nothing', async () => {
    await http()
      .put(`/admin/businesses/${a}/limits`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({
        aiMonthlyCap: null,
        aiDailyCapPerConversation: null,
        catalogItemCap: 3,
      })
      .expect(200, {
        aiMonthlyCap: null,
        aiDailyCapPerConversation: null,
        catalogItemCap: 3,
      });
    const preview = await previewCsv(CSV);

    const res = await applyImport(preview.id).expect(409);

    expect(res.body).toMatchObject({ code: 'CATALOG_CAP_EXCEEDED' });
    expect(await prisma.catalogItem.count()).toBe(0);
    expect(
      (
        await prisma.catalogImport.findUniqueOrThrow({
          where: { id: preview.id },
        })
      ).status,
    ).toBe('PREVIEW');
  });

  it('a limits PUT without catalogItemCap keeps it', async () => {
    await prisma.business.update({
      where: { id: a },
      data: { catalogItemCap: 7 },
    });

    await http()
      .put(`/admin/businesses/${a}/limits`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({ aiMonthlyCap: 10, aiDailyCapPerConversation: null })
      .expect(200, {
        aiMonthlyCap: 10,
        aiDailyCapPerConversation: null,
        catalogItemCap: 7,
      });
  });

  it('JSON rows import with the same process', async () => {
    const res = await http()
      .post(admin('imports'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .send({
        rows: [
          { sku: 'P1', title: 'Pote 1 kg', cost: 8000, stock: true },
          { sku: 'P2', title: 'Pote 1/4', cost: 'no sé', stock: true },
        ],
        mapping: {
          externalId: 'sku',
          name: 'title',
          price: 'cost',
          available: 'stock',
        },
      })
      .expect(201);

    expect((res.body as ImportBody).errors).toEqual([
      { row: 2, message: 'Fila 2: el precio "no sé" no es un número.' },
    ]);
  });

  it('rejects other content types, bad mappings and missing name columns', async () => {
    await http()
      .post(admin('imports'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .set('Content-Type', 'text/plain')
      .send('producto\nTorta')
      .expect(415);
    await http()
      .post(admin('imports'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .set('Content-Type', 'text/csv')
      .send('sku,precio\nA,1')
      .expect(400);
    await http()
      .post(
        `${admin('imports')}?mapping=${encodeURIComponent('{"name":"nombre"}')}`,
      )
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .set('Content-Type', 'text/csv')
      .send('sku,precio\nA,1')
      .expect(400);
    await http()
      .post(
        `${admin('imports')}?mapping=${encodeURIComponent('{"name":"sku"}')}`,
      )
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .set('Content-Type', 'text/csv')
      .send('sku,precio\nA,1')
      .expect(201);
    await http()
      .post(admin('imports'))
      .set('Content-Type', 'text/csv')
      .send(CSV)
      .expect(401);
  });

  it('discard keeps the catalog as it was', async () => {
    const preview = await previewCsv(CSV);

    await http()
      .post(admin(`imports/${preview.id}/discard`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);

    await applyImport(preview.id).expect(409);
    expect(await prisma.catalogItem.count()).toBe(0);
  });

  it('a preview older than 24 hours can no longer be applied', async () => {
    const preview = await previewCsv(CSV);
    await prisma.catalogImport.update({
      where: { id: preview.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });

    const res = await applyImport(preview.id).expect(409);
    expect(res.body).toMatchObject({ code: 'IMPORT_EXPIRED' });
  });

  it('PUT and DELETE one item by its code; listing filters', async () => {
    const put = (code: string, body: object) =>
      http()
        .put(admin(`items/${encodeURIComponent(code)}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send(body);

    const created = await put('K-1', {
      name: 'Kilo',
      price: 12000,
      category: 'Potes',
      attributes: { sabores: 4 },
    }).expect(200);
    expect(created.body).toMatchObject({
      externalId: 'K-1',
      price: '12000.00',
      available: true,
      attributes: { sabores: 4 },
    });
    await put('K-1', { name: 'Kilo', price: '13.000' }).expect(200);
    expect(
      (await prisma.catalogItem.findFirstOrThrow()).price?.toFixed(2),
    ).toBe('13000.00');
    await put('K-2', { name: 'X', price: 'gratis' }).expect(400);
    await put('K-2', { name: 'X', extra: 1 }).expect(400);

    await http()
      .delete(admin('items/K-1'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ available: false }));
    await http()
      .delete(admin('items/nope'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(404);
    expect(await prisma.catalogItem.count()).toBe(1);

    await importCsv(CSV);
    const list = await http()
      .get(`${admin('items')}?category=Helados&available=true&query=leche`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);
    expect(
      (list.body as { items: { externalId: string }[] }).items.map(
        (i) => i.externalId,
      ),
    ).toEqual(['H2']);
  });

  it('a PUT without available keeps a sold-out item sold out; codes are normalized', async () => {
    const put = (code: string, body: object) =>
      http()
        .put(admin(`items/${encodeURIComponent(code)}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send(body);
    await put('K  1', {
      name: 'Kilo',
      price: 100,
      attributes: { name: 'x' },
    })
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({ attributes: { name: 'x' } }),
      );
    await http()
      .delete(admin('items/K%201'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);

    const updated = await put('K 1', { name: 'Kilo', price: 120 }).expect(200);

    expect(updated.body).toMatchObject({
      externalId: 'K 1',
      price: '120.00',
      available: false,
      // Every PUT replaces the whole item: no attributes sent, none kept.
      attributes: {},
    });
    expect(await prisma.catalogItem.count()).toBe(1);
    await put('K 1', { name: 'Kilo', available: 'sí' })
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ available: true }));
    // A new item without available is available.
    await put('K2', { name: 'Otro' })
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ available: true }));
  });

  describe('search_catalog', () => {
    beforeEach(async () => {
      await importCsv(CSV);
      await importCsv(
        'codigo,producto,precio\nX1,Chocolate amargo especial,1\nX2,Dulce de leche granizado,1',
        b,
      );
      await prisma.catalogItem.updateMany({
        where: { businessId: a, externalId: 'T1' },
        data: { available: false },
      });
    });

    const names = async (
      query: string,
      extra: { category?: string; maxPrice?: number } = {},
    ) =>
      (
        await catalog.search(a, {
          query,
          category: extra.category ?? null,
          maxPrice: extra.maxPrice ?? null,
        })
      ).map((i) => i.name);

    it('tolerates typos and accents', async () => {
      expect(await names('chocolate amrgo')).toEqual(['Chocolate amargo']);
      expect(await names('dulce de lehe')).toEqual(['Dulce de leche']);
      expect(await names('limon')).toEqual(['Limón']);
    });

    it('never returns items of another business or unavailable ones', async () => {
      expect(await names('torta helada')).toEqual([]);
      expect(await names('granizado')).toEqual([]);
    });

    it('respects max_price and category', async () => {
      expect(await names('helado', { maxPrice: 1400 })).toEqual(
        expect.not.arrayContaining(['Chocolate amargo']),
      );
      expect(await names('chocolate amargo', { maxPrice: 1000 })).toEqual([]);
      expect(await names('dulce de leche', { category: 'postres' })).toEqual(
        [],
      );
      expect(await names('dulce de leche', { category: 'HELADOS' })).toEqual([
        'Dulce de leche',
      ]);
    });

    it('gives the model up to 8 items with the price as a number', async () => {
      const [item] = await catalog.search(a, {
        query: 'chocolate',
        category: null,
        maxPrice: null,
      });
      expect(item).toEqual({
        name: 'Chocolate amargo',
        description: 'Cacao 70%',
        category: 'Helados',
        price: 1500,
        currency: 'ARS',
        attributes: { sabor: 'intenso' },
      });
    });
  });

  describe('backoffice routes', () => {
    const inbox = (path: string, business = a) =>
      `/inbox/businesses/${business}/settings/catalog/${path}`;

    it('an OWNER imports and applies; the import records who made it', async () => {
      const cookie = await sessionOf('olga@example.com');
      const preview = await http()
        .post(inbox('imports'))
        .set('Cookie', cookie)
        .set('Content-Type', 'text/csv')
        .send(CSV)
        .expect(201);
      await http()
        .post(inbox(`imports/${(preview.body as ImportBody).id}/apply`))
        .set('Cookie', cookie)
        .expect(200);

      const stored = await prisma.catalogImport.findFirstOrThrow({
        include: { createdBy: true },
      });
      expect(stored.createdBy?.email).toBe('olga@example.com');
      expect(await prisma.catalogItem.count({ where: { businessId: a } })).toBe(
        4,
      );
    });

    it('an AGENT gets 403 on every catalog route', async () => {
      const cookie = await sessionOf('ana@example.com');
      const preview = await previewCsv(CSV);
      const sends = [
        () =>
          http()
            .post(inbox('imports'))
            .set('Content-Type', 'text/csv')
            .send(CSV),
        () => http().post(inbox(`imports/${preview.id}/apply`)),
        () => http().post(inbox(`imports/${preview.id}/discard`)),
        () => http().get(inbox(`imports/${preview.id}`)),
        () => http().get(inbox('items')),
        () => http().put(inbox('items/A')).send({ name: 'A' }),
        () => http().delete(inbox('items/A')),
      ];
      for (const send of sends) {
        await send().set('Cookie', cookie).expect(403);
      }
      expect(await prisma.catalogItem.count()).toBe(0);
    });

    it("a user of another business gets 403 and cannot touch this one's imports", async () => {
      const cookie = await sessionOf('bruno@example.com');
      const preview = await previewCsv(CSV);

      await http().get(inbox('items')).set('Cookie', cookie).expect(403);
      // Through their own business, another business's import is not found.
      await http()
        .post(inbox(`imports/${preview.id}/apply`, b))
        .set('Cookie', cookie)
        .expect(404);
      expect(await prisma.catalogItem.count()).toBe(0);
    });
  });
});
