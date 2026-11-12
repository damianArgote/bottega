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
import {
  SHEET_FETCHER,
  type SheetFetcher,
} from '../../src/catalog/sheet-fetcher.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv';

const HELADOS = [
  'codigo;producto;categoria;precio',
  'H1;Chocolate amargo;Helados;1500',
  'H2;Dulce de leche;Helados;1400',
].join('\n');
const POSTRES = [
  'codigo;producto;categoria;precio',
  'T1;Torta helada;Postres;9000',
].join('\n');

type CatalogBody = {
  id: string;
  name: string;
  position: number;
  availableItems: number;
  sheet: {
    url: string | null;
    syncedAt: string | null;
    syncError: string | null;
  };
};
type ImportBody = { id: string; summary: Record<string, number> };

describe('Several catalogs (integration, HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let catalog: CatalogService;
  const fetchSheet = vi.fn<SheetFetcher>();
  let a: string;
  let b: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SHEET_FETCHER)
      .useValue(fetchSheet)
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

  beforeEach(async () => {
    fetchSheet.mockReset();
    await resetDb(prisma);
    a = (await createLine(prisma, { slug: 'kubbo', phoneNumberId: '222' }))
      .businessId;
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
  });

  const http = () => request(app.getHttpServer());
  const adminCatalogs = (business = a) =>
    `/admin/businesses/${business}/catalogs`;
  const adminIn = (catalogId: string, path: string, business = a) =>
    `${adminCatalogs(business)}/${catalogId}/${path}`;
  const legacy = (path: string, business = a) =>
    `/admin/businesses/${business}/catalog/${path}`;

  const sessionOf = async (email: string) => {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const lines = res.headers['set-cookie'] as unknown as string[];
    return lines.find((l) => l.startsWith('bottega_session='))!.split(';')[0]!;
  };

  const createCatalog = async (name: string, business = a) =>
    (
      await http()
        .post(adminCatalogs(business))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name })
        .expect(201)
    ).body as CatalogBody;

  const listCatalogs = async (business = a) =>
    (
      await http()
        .get(adminCatalogs(business))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200)
    ).body as CatalogBody[];

  /** Previews a CSV at `base` (a catalog's or the old route) and applies it. */
  const importAt = async (base: string, csv: string, expectApply = 200) => {
    const preview = (
      await http()
        .post(`${base}imports`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .set('Content-Type', 'text/csv')
        .send(csv)
        .expect(201)
    ).body as ImportBody;
    return http()
      .post(`${base}imports/${preview.id}/apply`)
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(expectApply);
  };
  const importInto = (catalogId: string, csv: string, expectApply = 200) =>
    importAt(adminIn(catalogId, ''), csv, expectApply);

  const available = async (catalogId: string) =>
    (
      await prisma.catalogItem.findMany({
        where: { catalogId, available: true },
        orderBy: { externalId: 'asc' },
      })
    ).map((i) => i.externalId);

  describe('imports per catalog', () => {
    it('importing one catalog never marks items of another one unavailable', async () => {
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      await importInto(helados.id, HELADOS);
      await importInto(postres.id, POSTRES);

      expect(await available(helados.id)).toEqual(['H1', 'H2']);
      expect(await available(postres.id)).toEqual(['T1']);

      // A new file for Helados without H2: only H2 goes, Postres stays.
      const summary = (
        await importInto(
          helados.id,
          'codigo;producto;precio\nH1;Chocolate amargo;1500',
        )
      ).body as ImportBody;
      expect(summary.summary).toMatchObject({ unavailable: 1 });
      expect(await available(helados.id)).toEqual(['H1']);
      expect(await available(postres.id)).toEqual(['T1']);
    });

    it('the item cap counts the available items of all the catalogs', async () => {
      await prisma.business.update({
        where: { id: a },
        data: { catalogItemCap: 2 },
      });
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      await importInto(helados.id, HELADOS);

      const res = await importInto(postres.id, POSTRES, 409);
      expect(res.body).toMatchObject({ code: 'CATALOG_CAP_EXCEEDED' });
      expect(await available(postres.id)).toEqual([]);
      await http()
        .put(adminIn(postres.id, 'items/T9'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name: 'Torta', price: 10 })
        .expect(409);
      expect(await prisma.catalogItem.count({ where: { businessId: a } })).toBe(
        2,
      );
    });

    it('a code already in another catalog gives 409 until the next deploy', async () => {
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      await importInto(helados.id, HELADOS);

      const res = await importInto(
        postres.id,
        'codigo;producto;precio\nH1;Chocolate mayorista;900',
        409,
      );
      const conflict = res.body as { code: string; message: string };
      expect(conflict.code).toBe('CATALOG_CODE_IN_OTHER_CATALOG');
      expect(conflict.message).toContain('"H1"');
      const put = await http()
        .put(adminIn(postres.id, 'items/H2'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name: 'Dulce de leche', price: 800 })
        .expect(409);
      expect(put.body).toMatchObject({ code: 'CATALOG_CODE_IN_OTHER_CATALOG' });
      expect(await available(postres.id)).toEqual([]);
      expect(await available(helados.id)).toEqual(['H1', 'H2']);
    });

    it('saves the confirmed mapping per catalog', async () => {
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      const headers = ['art', 'detalle', 'valor'];
      const mapping = { externalId: 'art', name: 'detalle', price: 'valor' };
      await http()
        .post(
          `${adminIn(helados.id, 'imports')}?mapping=${encodeURIComponent(JSON.stringify(mapping))}`,
        )
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .set('Content-Type', 'text/csv')
        .send('art;detalle;valor\nX1;Cucurucho;100')
        .expect(201);

      expect(
        await catalog.savedMapping(
          { businessId: a, catalogId: helados.id },
          headers,
        ),
      ).toEqual(mapping);
      expect(
        await catalog.savedMapping(
          { businessId: a, catalogId: postres.id },
          headers,
        ),
      ).toBeNull();
    });
  });

  describe('old routes', () => {
    it('create "Catálogo principal" when the business has none and act on the first catalog', async () => {
      await importAt(legacy(''), HELADOS);
      const [principal] = await listCatalogs();
      expect(principal).toMatchObject({
        name: 'Catálogo principal',
        position: 0,
        availableItems: 2,
      });

      const postres = await createCatalog('Postres');
      await http()
        .put(legacy('items/C1'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name: 'Cucurucho', price: 300 })
        .expect(200);
      expect(await available(principal!.id)).toEqual(['C1', 'H1', 'H2']);
      expect(await available(postres.id)).toEqual([]);

      const items = await http()
        .get(legacy('items'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect((items.body as { items: unknown[] }).items).toHaveLength(3);
    });

    it('follow the position: moving another catalog first moves the old routes', async () => {
      const principal = await createCatalog('Principal');
      const postres = await createCatalog('Postres');
      await http()
        .patch(`${adminCatalogs()}/${postres.id}`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ position: -1 })
        .expect(400);
      await http()
        .patch(`${adminCatalogs()}/${principal.id}`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ position: 5 })
        .expect(200);

      await importAt(legacy(''), POSTRES);
      expect(await available(postres.id)).toEqual(['T1']);
      expect((await listCatalogs()).map((c) => c.name)).toEqual([
        'Postres',
        'Principal',
      ]);
    });

    it('take in the items and imports the previous version wrote without a catalog during a deploy', async () => {
      await importAt(legacy(''), HELADOS);
      const [principal] = await listCatalogs();
      // As the previous version writes them while the new one deploys.
      await prisma.$executeRaw`
        INSERT INTO catalog_item (id, business_id, external_id, name, row_hash, updated_at)
        VALUES (gen_random_uuid(), ${a}::uuid, 'OLD1', 'Fugazzeta vieja', 'h', now())`;
      const oldImport = await prisma.catalogImport.create({
        data: {
          businessId: a,
          source: 'CSV',
          summary: {},
          rows: [],
          sourceRecords: { records: [], rows: [] },
        },
      });

      const put = await http()
        .put(legacy('items/OLD1'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name: 'Fugazzeta', price: 7 })
        .expect(200);
      expect(put.body).toMatchObject({ externalId: 'OLD1', name: 'Fugazzeta' });
      expect(await available(principal!.id)).toEqual(['H1', 'H2', 'OLD1']);
      await http()
        .get(legacy(`imports/${oldImport.id}`))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      await http()
        .delete(legacy('items/OLD1'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect(
        await prisma.catalogItem.count({
          where: { businessId: a, catalogId: null },
        }),
      ).toBe(0);
    });

    it('keep the old backoffice routes working', async () => {
      const cookie = await sessionOf('olga@example.com');
      await http()
        .put(`/inbox/businesses/${a}/settings/catalog/items/C1`)
        .set('Cookie', cookie)
        .send({ name: 'Cucurucho', price: 300 })
        .expect(200);
      const [principal] = await listCatalogs();
      expect(await available(principal!.id)).toEqual(['C1']);
    });
  });

  describe('catalog routes', () => {
    it('create, rename and list catalogs in order, with their available items and sheet', async () => {
      const helados = await createCatalog('  Helados  ');
      expect(helados).toMatchObject({ name: 'Helados', position: 0 });
      const postres = await createCatalog('Postres');
      expect(postres.position).toBe(1);
      await importInto(helados.id, HELADOS);
      await http()
        .put(adminIn(postres.id, 'sheet'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ url: SHEET_URL })
        .expect(200);
      const renamed = await http()
        .patch(`${adminCatalogs()}/${postres.id}`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name: 'Postres y tortas' })
        .expect(200);
      expect(renamed.body).toMatchObject({ name: 'Postres y tortas' });

      expect(await listCatalogs()).toMatchObject([
        { name: 'Helados', availableItems: 2, sheet: { url: null } },
        {
          name: 'Postres y tortas',
          availableItems: 0,
          sheet: { url: SHEET_URL },
        },
      ]);
    });

    it('rejects a repeated name (case and accents ignored), a bad name and going over the cap', async () => {
      await createCatalog('Catálogo Mayorista');
      for (const name of ['catalogo  mayorista', 'CATÁLOGO MAYORISTA']) {
        const res = await http()
          .post(adminCatalogs())
          .set('X-Admin-Api-Key', ADMIN_KEY)
          .send({ name })
          .expect(409);
        expect(res.body).toMatchObject({ code: 'CATALOG_NAME_TAKEN' });
      }
      for (const name of ['', '   ', 'x'.repeat(61)]) {
        await http()
          .post(adminCatalogs())
          .set('X-Admin-Api-Key', ADMIN_KEY)
          .send({ name })
          .expect(400);
      }
      for (let i = 2; i <= 10; i += 1) {
        await createCatalog(`Lista ${i}`);
      }
      const res = await http()
        .post(adminCatalogs())
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ name: 'Lista 11' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'CATALOG_LIMIT_REACHED' });
      expect(await prisma.catalog.count({ where: { businessId: a } })).toBe(10);
    });

    it('deletes a catalog with its items, but never the last one', async () => {
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      await importInto(postres.id, POSTRES);

      await http()
        .delete(`${adminCatalogs()}/${postres.id}`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect(await prisma.catalogItem.count({ where: { businessId: a } })).toBe(
        0,
      );

      const res = await http()
        .delete(`${adminCatalogs()}/${helados.id}`)
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(409);
      expect(res.body).toMatchObject({ code: 'LAST_CATALOG' });
      expect(await prisma.catalog.count({ where: { businessId: a } })).toBe(1);
    });

    it("gives 404 for another business's catalog", async () => {
      const theirs = await createCatalog('Suyo', b);
      await importAt(adminIn(theirs.id, '', b), POSTRES);
      const send = [
        () => http().get(adminIn(theirs.id, 'items')),
        () => http().put(adminIn(theirs.id, 'items/T1')).send({ name: 'X' }),
        () =>
          http().patch(`${adminCatalogs()}/${theirs.id}`).send({ name: 'Mío' }),
        () => http().delete(`${adminCatalogs()}/${theirs.id}`),
      ];
      for (const s of send) {
        await s().set('X-Admin-Api-Key', ADMIN_KEY).expect(404);
      }
      const cookie = await sessionOf('olga@example.com');
      await http()
        .get(`/inbox/businesses/${a}/settings/catalogs/${theirs.id}/items`)
        .set('Cookie', cookie)
        .expect(404);
      expect(await available(theirs.id)).toEqual(['T1']);
    });

    it('lets OWNERs manage catalogs in the backoffice; an AGENT gets 403', async () => {
      const owner = await sessionOf('olga@example.com');
      const base = `/inbox/businesses/${a}/settings/catalogs`;
      const created = await http()
        .post(base)
        .set('Cookie', owner)
        .send({ name: 'Postres' })
        .expect(201);
      const id = (created.body as CatalogBody).id;
      await http()
        .put(`${base}/${id}/items/T1`)
        .set('Cookie', owner)
        .send({ name: 'Torta', price: 10 })
        .expect(200);
      const listed = await http().get(base).set('Cookie', owner).expect(200);
      expect((listed.body as CatalogBody[]).map((c) => c.name)).toEqual([
        'Postres',
      ]);

      const agent = await sessionOf('ana@example.com');
      for (const send of [
        () => http().get(base),
        () => http().post(base).send({ name: 'Otro' }),
        () => http().patch(`${base}/${id}`).send({ name: 'Otro' }),
        () => http().delete(`${base}/${id}`),
        () => http().get(`${base}/${id}/items`),
      ]) {
        await send().set('Cookie', agent).expect(403);
      }
    });
  });

  describe('sheet per catalog', () => {
    it('a sync only touches its catalog and its 30% guard counts that catalog alone', async () => {
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      // 10 helados and 1 postre (from the sheet).
      await importInto(
        helados.id,
        [
          'codigo;producto;precio',
          ...Array.from({ length: 10 }, (_, i) => `H${i};Helado ${i};100`),
        ].join('\n'),
      );
      await http()
        .put(adminIn(postres.id, 'sheet'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .send({ url: SHEET_URL })
        .expect(200);
      fetchSheet.mockResolvedValueOnce(
        'codigo;producto;precio\nT1;Torta;9000\nT2;Flan;800',
      );
      const first = await http()
        .post(adminIn(postres.id, 'sync'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect(first.body).toMatchObject({ outcome: 'applied' });
      expect(await available(postres.id)).toEqual(['T1', 'T2']);
      expect(await available(helados.id)).toHaveLength(10);

      // T2 leaves the sheet: half of Postres (1 of 11 in the business).
      fetchSheet.mockResolvedValueOnce('codigo;producto;precio\nT1;Torta;9000');
      const second = await http()
        .post(adminIn(postres.id, 'sync'))
        .set('X-Admin-Api-Key', ADMIN_KEY)
        .expect(200);
      expect(second.body).toMatchObject({ outcome: 'preview' });
      expect(await available(postres.id)).toEqual(['T1', 'T2']);
      expect(fetchSheet).toHaveBeenCalledWith(SHEET_URL);
    });
  });

  describe('search_catalog', () => {
    it('searches every catalog of the business and says which catalog each item is in', async () => {
      const helados = await createCatalog('Helados');
      const postres = await createCatalog('Postres');
      await importInto(helados.id, HELADOS);
      await importInto(postres.id, POSTRES);
      const theirs = await createCatalog('Suyo', b);
      await importAt(
        adminIn(theirs.id, '', b),
        'codigo;producto;precio\nX1;Torta de chocolate;1',
      );

      const found = await catalog.search(a, {
        query: 'chocolate',
        category: null,
        maxPrice: null,
      });
      expect(found.map((i) => [i.name, i.catalog])).toEqual([
        ['Chocolate amargo', 'Helados'],
      ]);
      const torta = await catalog.search(a, {
        query: 'torta',
        category: null,
        maxPrice: null,
      });
      expect(torta.map((i) => [i.name, i.catalog])).toEqual([
        ['Torta helada', 'Postres'],
      ]);
      expect(await catalog.hasAvailable(a)).toBe(true);
    });
  });
});
