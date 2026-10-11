import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  const checkDatabase = vi.fn();
  let controller: HealthController;

  beforeEach(async () => {
    checkDatabase.mockReset();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { checkDatabase } }],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('returns ok when the database is up', async () => {
    checkDatabase.mockResolvedValue('up');

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      db: 'up',
    });
  });

  it('throws 503 with db down when the database is unreachable', async () => {
    checkDatabase.mockResolvedValue('down');

    const result = controller.check();

    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: { status: 'error', db: 'down' },
    });
  });
});
