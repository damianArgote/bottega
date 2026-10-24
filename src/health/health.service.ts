import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export type DbStatus = 'up' | 'down';

/**
 * Upper bound for the health query. A suspended Neon compute can take
 * seconds to wake; the health check reports "down" instead of hanging.
 */
export const HEALTH_DB_TIMEOUT_MS = 3_000;

class HealthTimeoutError extends Error {
  override name = 'HealthTimeoutError';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async checkDatabase(): Promise<DbStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HealthTimeoutError()),
        HEALTH_DB_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return 'up';
    } catch (error) {
      // Log only the error class; driver messages may include connection details.
      const name = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(`Database health check failed (${name})`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
