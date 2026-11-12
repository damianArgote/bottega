import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { TEST_DATABASE_URL } from './database-url.js';

/** The migration under test: deploy 1 of prompt 12a. */
const MIGRATION = '20261112120000_catalogs';
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

/** A database of its own: this spec rebuilds it from the migrations. */
function scratchUrl(): URL {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = '/bottega_catalog_migration_test';
  return url;
}

function client(url: URL): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }),
  });
}

/** Runs a SQL script as one command (several statements) on `url`. */
function execute(url: URL, file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    env: {
      ...process.env,
      DATABASE_URL: url.toString(),
      DATABASE_URL_UNPOOLED: url.toString(),
    },
    stdio: 'pipe',
  });
}

describe(`migration ${MIGRATION}`, () => {
  const url = scratchUrl();
  const scratch = mkdtempSync(join(tmpdir(), 'catalog-migration-'));
  let db: PrismaClient;

  beforeAll(async () => {
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    const admin = client(adminUrl);
    try {
      const name = url.pathname.slice(1);
      // Identifiers cannot be bound parameters; `name` is a constant.
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.$disconnect();
    }
    const previous = readdirSync(MIGRATIONS_DIR)
      .filter((dir) => /^\d{14}_/.test(dir) && dir < MIGRATION)
      .sort()
      .map((dir) =>
        readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'),
      );
    const before = join(scratch, 'before.sql');
    writeFileSync(before, previous.join('\n;\n'));
    execute(url, before);
    db = client(url);
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('gives each business with items, imports or a sheet its "Catálogo principal" and fills catalog_id', async () => {
    const mapping = {
      headers: ['producto', 'precio'],
      mapping: { name: 'producto', price: 'precio' },
    };
    await db.$executeRaw`
      INSERT INTO business (id, name, slug, bot_name, updated_at,
        catalog_mapping, catalog_sheet_url, catalog_sync_next_at,
        catalog_synced_at, catalog_sync_error)
      VALUES
        ('00000000-0000-0000-0000-00000000000a', 'Con todo', 'con-todo', 'Bot', now(),
         ${JSON.stringify(mapping)}::jsonb,
         'https://docs.google.com/spreadsheets/d/e/x/pub?output=csv',
         '2026-11-12 10:00:00', '2026-11-12 09:00:00', 'sheet_http_404'),
        ('00000000-0000-0000-0000-00000000000b', 'Solo planilla', 'solo-planilla', 'Bot', now(),
         NULL, 'https://docs.google.com/spreadsheets/d/e/y/pub?output=csv',
         NULL, NULL, NULL),
        ('00000000-0000-0000-0000-00000000000c', 'Sin catalogo', 'sin-catalogo', 'Bot', now(),
         NULL, NULL, NULL, NULL, NULL),
        ('00000000-0000-0000-0000-00000000000d', 'Solo importacion', 'solo-importacion', 'Bot', now(),
         NULL, NULL, NULL, NULL, NULL)`;
    await db.$executeRaw`
      INSERT INTO catalog_item (id, business_id, external_id, name, row_hash, updated_at)
      VALUES
        (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', 'a1', 'Chocolate', 'h1', now()),
        (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', 'a2', 'Frutilla', 'h2', now())`;
    await db.$executeRaw`
      INSERT INTO catalog_import (id, business_id, source, summary)
      VALUES
        (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', 'csv', '{}'),
        (gen_random_uuid(), '00000000-0000-0000-0000-00000000000d', 'sheet', '{}')`;

    execute(url, join(MIGRATIONS_DIR, MIGRATION, 'migration.sql'));

    const catalogs = await db.catalog.findMany({
      orderBy: { businessId: 'asc' },
    });
    expect(
      catalogs.map((c) => [
        c.businessId.slice(-1),
        c.name,
        c.nameKey,
        c.position,
        c.audience,
      ]),
    ).toEqual([
      ['a', 'Catálogo principal', 'catalogo principal', 0, 'ALL'],
      ['b', 'Catálogo principal', 'catalogo principal', 0, 'ALL'],
      ['d', 'Catálogo principal', 'catalogo principal', 0, 'ALL'],
    ]);
    const full = catalogs[0]!;
    expect(full).toMatchObject({
      mapping,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/e/x/pub?output=csv',
      syncNextAt: new Date('2026-11-12T10:00:00Z'),
      syncedAt: new Date('2026-11-12T09:00:00Z'),
      syncError: 'sheet_http_404',
      replacesAll: false,
    });
    expect(catalogs[1]!.sheetUrl).toBe(
      'https://docs.google.com/spreadsheets/d/e/y/pub?output=csv',
    );

    const items = await db.catalogItem.findMany();
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.catalogId === full.id)).toBe(true);
    const imports = await db.catalogImport.findMany({
      orderBy: { businessId: 'asc' },
    });
    expect(imports.map((i) => i.catalogId)).toEqual([full.id, catalogs[2]!.id]);

    // The previous version keeps working: its columns are still there.
    const [legacy] = await db.$queryRaw<
      Array<{ catalog_sheet_url: string | null }>
    >`
      SELECT catalog_sheet_url FROM business WHERE id = '00000000-0000-0000-0000-00000000000a'`;
    expect(legacy?.catalog_sheet_url).toBe(
      'https://docs.google.com/spreadsheets/d/e/x/pub?output=csv',
    );
  });
});
