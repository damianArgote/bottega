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
import { CatalogSyncScheduler } from '../../src/catalog/catalog-sync.scheduler.js';
import {
  SHEET_FETCHER,
  SheetFetchError,
  type SheetFetcher,
} from '../../src/catalog/sheet-fetcher.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createLine, resetDb } from './helpers.js';

const ADMIN_KEY = 'int-admin-api-key-0123456789abcdef';
const PASSWORD = 'una clave larga';
const URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-kubbo/pub?gid=0&single=true&output=csv';

/** A sheet with `n` flavors (codes F0..F(n-1)); `extra` rows appended. */
const sheet = (n: number, price = 1000, extra: string[] = []) =>
  [
    'codigo,producto,precio',
    ...Array.from({ length: n }, (_, i) => `F${i},Sabor ${i},${price + i}`),
    ...extra,
  ].join('\n');

type SyncBody = {
  outcome: 'unchanged' | 'applied' | 'preview';
  import?: { id: string; status: string; summary: Record<string, number> };
};

describe('Catalog Google Sheet sync (integration, HTTP)', () => {
  const fetchSheet = vi.fn<SheetFetcher>();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let scheduler: CatalogSyncScheduler;
  let a: string;

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
    scheduler = app.get(CatalogSyncScheduler);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fetchSheet.mockReset();
    a = (await createLine(prisma, { slug: 'kubbo', phoneNumberId: '222' }))
      .businessId;
  });

  const http = () => request(app.getHttpServer());
  const admin = (path: string) => `/admin/businesses/${a}/catalog/${path}`;
  const setSheet = (url: string | null) =>
    http().put(admin('sheet')).set('X-Admin-Api-Key', ADMIN_KEY).send({ url });
  const sync = () =>
    http().post(admin('sync')).set('X-Admin-Api-Key', ADMIN_KEY);
  const available = () =>
    prisma.catalogItem.count({ where: { businessId: a, available: true } });

  it('a URL that is not a Google Sheet published as CSV gives 400', async () => {
    for (const url of [
      'https://evil.example.com/catalogo.csv',
      'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
      URL.replace('output=csv', 'output=html'),
    ]) {
      await setSheet(url).expect(400);
    }
    expect(
      (await prisma.business.findUniqueOrThrow({ where: { id: a } }))
        .catalogSheetUrl,
    ).toBeNull();
  });

  it('setting the sheet makes it due now; removing it stops the sync', async () => {
    const res = await setSheet(URL).expect(200);
    expect(res.body).toMatchObject({ url: URL, syncError: null });
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: a },
    });
    expect(business.catalogSyncNextAt!.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );

    await setSheet(null).expect(200, {
      url: null,
      syncedAt: null,
      syncError: null,
      nextSyncAt: null,
    });
  });

  it('a clean sync applies by itself; the same sheet again changes nothing and keeps no import', async () => {
    await setSheet(URL).expect(200);
    fetchSheet.mockResolvedValue(sheet(10));

    const first = (await sync().expect(200)).body as SyncBody;
    expect(first).toMatchObject({
      outcome: 'applied',
      import: { status: 'APPLIED', summary: { created: 10 } },
    });
    expect(fetchSheet).toHaveBeenCalledWith(URL);
    expect(await available()).toBe(10);

    const second = (await sync().expect(200)).body as SyncBody;
    expect(second).toEqual({ outcome: 'unchanged' });
    expect(await prisma.catalogImport.count()).toBe(1);
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: a },
    });
    expect(business.catalogSyncedAt).not.toBeNull();
    expect(business.catalogSyncError).toBeNull();
  });

  it('a sync that would leave more than 30% unavailable stays as a preview', async () => {
    await setSheet(URL).expect(200);
    fetchSheet.mockResolvedValueOnce(sheet(10));
    await sync().expect(200);

    // 3 of 10 gone (30%): applied by itself.
    fetchSheet.mockResolvedValueOnce(sheet(7));
    expect(((await sync().expect(200)).body as SyncBody).outcome).toBe(
      'applied',
    );
    expect(await available()).toBe(7);

    // 3 of 7 gone (43%): waits for a person.
    fetchSheet.mockResolvedValueOnce(sheet(4));
    const res = (await sync().expect(200)).body as SyncBody;
    expect(res).toMatchObject({
      outcome: 'preview',
      import: { status: 'PREVIEW', summary: { unavailable: 3 } },
    });
    expect(await available()).toBe(7);

    // A person applies it.
    await http()
      .post(admin(`imports/${res.import!.id}/apply`))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200);
    expect(await available()).toBe(4);
  });

  it('a sync with row errors stays as a preview; the same sheet keeps it, a changed one replaces it', async () => {
    await setSheet(URL).expect(200);
    fetchSheet.mockResolvedValue(sheet(3, 1000, ['F9,Sabor raro,consultar']));

    const first = (await sync().expect(200)).body as SyncBody;
    expect(first).toMatchObject({
      outcome: 'preview',
      import: { summary: { created: 3, errors: 1 } },
    });
    expect(await available()).toBe(0);

    const same = (await sync().expect(200)).body as SyncBody;
    expect(same.import?.id).toBe(first.import?.id);

    fetchSheet.mockResolvedValue(sheet(4, 1000, ['F9,Sabor raro,consultar']));
    await sync().expect(200);
    const imports = await prisma.catalogImport.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(imports.map((i) => i.status)).toEqual(['DISCARDED', 'PREVIEW']);
  });

  it('a sheet that cannot be read gives 502 and keeps the error code', async () => {
    await setSheet(URL).expect(200);
    fetchSheet.mockRejectedValueOnce(new SheetFetchError('sheet_http_404'));

    const res = await sync().expect(502);

    expect(res.body).toMatchObject({ code: 'sheet_http_404' });
    await http()
      .get(admin('sheet'))
      .set('X-Admin-Api-Key', ADMIN_KEY)
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({ syncError: 'sheet_http_404' }),
      );
  });

  it('without a sheet, sync gives 409', async () => {
    const res = await sync().expect(409);
    expect(res.body).toMatchObject({ code: 'NO_SHEET' });
  });

  describe('scheduler', () => {
    it('syncs only due businesses with a sheet and moves them one hour ahead', async () => {
      const other = (
        await createLine(prisma, { slug: 'otro', phoneNumberId: '333' })
      ).businessId;
      const later = new Date(Date.now() + 30 * 60_000);
      await prisma.business.update({
        where: { id: a },
        data: { catalogSheetUrl: URL, catalogSyncNextAt: new Date(0) },
      });
      await prisma.business.update({
        where: { id: other },
        data: { catalogSheetUrl: URL, catalogSyncNextAt: later },
      });
      fetchSheet.mockResolvedValue(sheet(2));

      expect(await scheduler.runDue()).toBe(1);

      expect(fetchSheet).toHaveBeenCalledTimes(1);
      expect(await available()).toBe(2);
      const next = (
        await prisma.business.findUniqueOrThrow({ where: { id: a } })
      ).catalogSyncNextAt!.getTime();
      expect(next - Date.now()).toBeGreaterThan(59 * 60_000);
      expect(await scheduler.runDue()).toBe(0);
      const delay = await scheduler.nextDelay();
      expect(delay).toBeGreaterThan(29 * 60_000);
      expect(delay).toBeLessThanOrEqual(30 * 60_000);
    });

    it('has nothing to wait for when no business has a sheet', async () => {
      expect(await scheduler.nextDelay()).toBeNull();
      expect(await scheduler.runDue()).toBe(0);
    });

    it('a failed scheduled sync stores the error and is due again in an hour', async () => {
      await prisma.business.update({
        where: { id: a },
        data: { catalogSheetUrl: URL, catalogSyncNextAt: new Date(0) },
      });
      fetchSheet.mockRejectedValueOnce(new SheetFetchError('sheet_timeout'));

      expect(await scheduler.runDue()).toBe(1);

      const business = await prisma.business.findUniqueOrThrow({
        where: { id: a },
      });
      expect(business.catalogSyncError).toBe('sheet_timeout');
      expect(business.catalogSyncNextAt!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('backoffice routes', () => {
    beforeEach(async () => {
      const users = app.get(UsersService);
      for (const [email, role] of [
        ['olga@example.com', 'OWNER'],
        ['ana@example.com', 'AGENT'],
      ] as const) {
        await users.addToBusiness(a, {
          email,
          name: email,
          password: PASSWORD,
          role,
        });
      }
    });

    const sessionOf = async (email: string) => {
      const res = await http()
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      const lines = res.headers['set-cookie'] as unknown as string[];
      return lines
        .find((l) => l.startsWith('bottega_session='))!
        .split(';')[0]!;
    };
    const inbox = (path: string) =>
      `/inbox/businesses/${a}/settings/catalog/${path}`;

    it('an OWNER sets the sheet and syncs now; the import records who asked', async () => {
      const cookie = await sessionOf('olga@example.com');
      fetchSheet.mockResolvedValue(sheet(2));

      await http()
        .put(inbox('sheet'))
        .set('Cookie', cookie)
        .send({ url: URL })
        .expect(200);
      await http()
        .post(inbox('sync'))
        .set('Cookie', cookie)
        .expect(200)
        .expect((r) => expect(r.body).toMatchObject({ outcome: 'applied' }));

      const stored = await prisma.catalogImport.findFirstOrThrow({
        include: { createdBy: true },
      });
      expect(stored.createdBy?.email).toBe('olga@example.com');
    });

    it('an AGENT gets 403 on the sheet routes', async () => {
      const cookie = await sessionOf('ana@example.com');
      await http().get(inbox('sheet')).set('Cookie', cookie).expect(403);
      await http()
        .put(inbox('sheet'))
        .set('Cookie', cookie)
        .send({ url: URL })
        .expect(403);
      await http().post(inbox('sync')).set('Cookie', cookie).expect(403);
    });
  });
});
