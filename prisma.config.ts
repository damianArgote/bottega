// Prisma 7 does not auto-load .env files; load them explicitly for the CLI.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The CLI (migrate, status) needs a direct connection: on Neon that is
    // DATABASE_URL_UNPOOLED, while the app keeps the pooled DATABASE_URL.
    // Locally (Docker) only DATABASE_URL is set and is used for both.
    // Read lazily (instead of `env()`) so `prisma generate` works without a
    // database URL, e.g. on a fresh `npm install`. Migrate commands still
    // require a URL and fail with a clear Prisma error when missing.
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  },
});
