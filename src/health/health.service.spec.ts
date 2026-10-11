import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  const queryRaw = vi.fn();
  let service: HealthService;

  beforeEach(async () => {
    queryRaw.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    service = moduleRef.get(HealthService);
  });

  it('reports the database as up when SELECT 1 succeeds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.checkDatabase()).resolves.toBe('up');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reports the database as down when the query fails', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(service.checkDatabase()).resolves.toBe('down');
  });
});
