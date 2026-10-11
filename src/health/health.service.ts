import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export type DbStatus = 'up' | 'down';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async checkDatabase(): Promise<DbStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch (error) {
      // Log only the error class; driver messages may include connection details.
      const name = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(`Database health check failed (${name})`);
      return 'down';
    }
  }
}
