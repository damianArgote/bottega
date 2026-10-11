import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';

export interface HealthResponse {
  status: 'ok' | 'error';
  db: 'up' | 'down';
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const db = await this.health.checkDatabase();
    if (db === 'down') {
      throw new ServiceUnavailableException({ status: 'error', db });
    }
    return { status: 'ok', db };
  }
}
