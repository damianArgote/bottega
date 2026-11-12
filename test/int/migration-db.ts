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

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

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

export interface MigrationDb {
  /** Client for the scratch database (its schema may lag the generated one). */
  db: PrismaClient;
  /** Applies `migration` (the one under test). */
  apply(): void;
  close(): Promise<void>;
}

/**
 * A database of its own (`database`, ending in `_test`) rebuilt with every
 * migration before `migration`, to load data in the old shape and then
 * apply `migration` alone.
 */
export async function migrationDb(
  database: string,
  migration: string,
): Promise<MigrationDb> {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = client(adminUrl);
  try {
    // Identifiers cannot be bound parameters; `database` is a constant.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.$disconnect();
  }
  const scratch = mkdtempSync(join(tmpdir(), 'migration-db-'));
  const previous = readdirSync(MIGRATIONS_DIR)
    .filter((dir) => /^\d{14}_/.test(dir) && dir < migration)
    .sort()
    .map((dir) =>
      readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'),
    );
  const before = join(scratch, 'before.sql');
  writeFileSync(before, previous.join('\n;\n'));
  execute(url, before);
  const db = client(url);
  return {
    db,
    apply: () => execute(url, join(MIGRATIONS_DIR, migration, 'migration.sql')),
    close: async () => {
      await db.$disconnect();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
