import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';

export interface HealthResponse {
  status: 'ok' | 'error';
  db: 'up' | 'down';
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness for the platform health check (Render): never touches the
   * database, so it answers fast while Neon is suspended and does not keep
   * waking it up.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness for monitoring: also checks the database (bounded wait). */
  @Get()
  async check(): Promise<HealthResponse> {
    const db = await this.health.checkDatabase();
    if (db === 'down') {
      throw new ServiceUnavailableException({ status: 'error', db });
    }
    return { status: 'ok', db };
  }
}
