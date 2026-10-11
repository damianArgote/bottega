// Prisma 7 does not auto-load .env files; load them explicitly for the CLI.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read lazily (instead of `env()`) so `prisma generate` works without a
    // database URL, e.g. on a fresh `npm install`. Migrate commands still
    // require DATABASE_URL and fail with a clear Prisma error when missing.
    url: process.env.DATABASE_URL,
  },
});
