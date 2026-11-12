import { type MigrationDb, migrationDb } from './migration-db.js';

/** The migration under test: deploy 2 of prompt 12a (contract). */
const MIGRATION = '20261113120000_catalogs_contract';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const FIRST = '00000000-0000-0000-0000-0000000000f1';
const SECOND = '00000000-0000-0000-0000-0000000000f2';

describe(`migration ${MIGRATION}`, () => {
  let scratch: MigrationDb;
  let db: MigrationDb['db'];

  beforeAll(async () => {
    scratch = await migrationDb(
      'bottega_catalog_contract_migration_test',
      MIGRATION,
    );
    db = scratch.db;
  }, 120_000);

  afterAll(async () => {
    await scratch?.close();
  });

  it('gives a catalog to the rows the previous version wrote, makes it required and drops the old columns and unique', async () => {
    await db.$executeRaw`
      INSERT INTO business (id, name, slug, bot_name, updated_at)
      VALUES (${A}::uuid, 'Con catalogos', 'con-catalogos', 'Bot', now()),
             (${B}::uuid, 'Sin catalogo', 'sin-catalogo', 'Bot', now())`;
    // The second catalog is created first: the first one is by position.
    await db.$executeRaw`
      INSERT INTO catalog (id, business_id, name, name_key, position, updated_at)
      VALUES (${SECOND}::uuid, ${A}::uuid, 'Postres', 'postres', 1, now()),
             (${FIRST}::uuid, ${A}::uuid, 'Catálogo principal', 'catalogo principal', 0, now())`;
    await db.$executeRaw`
      INSERT INTO catalog_item (id, business_id, catalog_id, external_id, name, row_hash, updated_at)
      VALUES
        (gen_random_uuid(), ${A}::uuid, ${SECOND}::uuid, 'T1', 'Torta', 'h', now()),
        -- Written by the previous version (deploy 1 code) without a catalog:
        -- cannot happen after deploy 1, but the data may predate it.
        (gen_random_uuid(), ${A}::uuid, NULL, 'OLD1', 'Fugazzeta', 'h', now()),
        (gen_random_uuid(), ${B}::uuid, NULL, 'B1', 'Muzzarella', 'h', now())`;
    await db.$executeRaw`
      INSERT INTO catalog_import (id, business_id, catalog_id, source, summary)
      VALUES (gen_random_uuid(), ${A}::uuid, NULL, 'csv', '{}'),
             (gen_random_uuid(), ${B}::uuid, NULL, 'sheet', '{}')`;

    scratch.apply();

    const items = await db.$queryRaw<
      Array<{ external_id: string; catalog_id: string; business_id: string }>
    >`SELECT external_id, catalog_id::text, business_id::text FROM catalog_item ORDER BY external_id`;
    const [principalOfB] = await db.$queryRaw<
      Array<{ id: string; name: string }>
    >`
      SELECT id::text, name FROM catalog WHERE business_id = ${B}::uuid`;
    expect(principalOfB?.name).toBe('Catálogo principal');
    expect(items).toEqual([
      { external_id: 'B1', catalog_id: principalOfB!.id, business_id: B },
      { external_id: 'OLD1', catalog_id: FIRST, business_id: A },
      { external_id: 'T1', catalog_id: SECOND, business_id: A },
    ]);
    const imports = await db.$queryRaw<Array<{ catalog_id: string }>>`
      SELECT catalog_id::text FROM catalog_import ORDER BY business_id`;
    expect(imports).toEqual([
      { catalog_id: FIRST },
      { catalog_id: principalOfB!.id },
    ]);

    // The same code in two catalogs of a business is now allowed.
    await db.$executeRaw`
      INSERT INTO catalog_item (id, business_id, catalog_id, external_id, name, row_hash, updated_at)
      VALUES (gen_random_uuid(), ${A}::uuid, ${FIRST}::uuid, 'T1', 'Torta mayorista', 'h', now())`;
    // ...but never twice in one catalog, and never without a catalog.
    await expect(db.$executeRaw`
      INSERT INTO catalog_item (id, business_id, catalog_id, external_id, name, row_hash, updated_at)
      VALUES (gen_random_uuid(), ${A}::uuid, ${FIRST}::uuid, 'T1', 'Otra', 'h', now())`).rejects.toThrow();
    await expect(db.$executeRaw`
      INSERT INTO catalog_item (id, business_id, external_id, name, row_hash, updated_at)
      VALUES (gen_random_uuid(), ${A}::uuid, 'X1', 'Sin catalogo', 'h', now())`).rejects.toThrow();

    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'business' AND column_name LIKE 'catalog_%'
      ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual(['catalog_item_cap']);
  });
});
