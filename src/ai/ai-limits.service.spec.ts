import { Logger } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AiLimitsService } from './ai-limits.service.js';

describe('AiLimitsService.logThresholds', () => {
  const service = new AiLimitsService(
    {} as PrismaService,
    {} as AppConfigService,
  );
  const logged = (before: number, after: number, cap = 5000) => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    service.logThresholds('business-1', cap, before, after);
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    log.mockRestore();
    return lines;
  };

  it('logs 80% once, on the turn that reaches it, with id, usage and cap', () => {
    expect(logged(3999, 4000)).toEqual([
      {
        event: 'ai_monthly_cap_threshold',
        businessId: 'business-1',
        percent: 80,
        used: 4000,
        cap: 5000,
      },
    ]);
    expect(logged(4000, 4001)).toEqual([]);
    expect(logged(3990, 3999)).toEqual([]);
  });

  it('logs 100% on the turn that reaches the cap', () => {
    expect(logged(4999, 5001).map((l) => l.percent)).toEqual([100]);
    expect(logged(5000, 5001)).toEqual([]);
  });

  it('logs both when one turn crosses both', () => {
    expect(logged(7, 10, 10).map((l) => l.percent)).toEqual([80, 100]);
  });

  it('rounds the threshold up (80% of 7 is the 6th call)', () => {
    expect(logged(5, 6, 7).map((l) => l.percent)).toEqual([80]);
  });
});
