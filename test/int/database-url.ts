/**
 * Integration tests run against a dedicated database on the local compose
 * instance. Override with TEST_DATABASE_URL; the database name must end in
 * `_test` because the suite truncates every table.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://bottega:bottega@localhost:5432/bottega_test';
