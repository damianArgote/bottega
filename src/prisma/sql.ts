import { Prisma } from '../generated/prisma/client.js';

/**
 * Current time as a UTC `timestamp without time zone`.
 *
 * Every DateTime column is `TIMESTAMP(3)` (no time zone) and Prisma stores
 * UTC wall-clock values in them, so raw SQL must compare and write against
 * UTC too, independent of the session `TimeZone` setting.
 */
export const UTC_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** Milliseconds as a SQL interval expression (bound parameter, no string concat). */
export const millis = (ms: number): Prisma.Sql =>
  Prisma.sql`(${ms}::double precision * interval '1 millisecond')`;

/** True when a Prisma/driver error is a PostgreSQL unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as {
      code?: unknown;
      meta?: { code?: unknown; driverAdapterError?: unknown };
      cause?: unknown;
      originalCode?: unknown;
    };
    if (
      candidate.code === 'P2002' ||
      candidate.code === '23505' ||
      candidate.originalCode === '23505' ||
      candidate.meta?.code === '23505'
    ) {
      return true;
    }
    current = candidate.meta?.driverAdapterError ?? candidate.cause;
  }
  return false;
}
