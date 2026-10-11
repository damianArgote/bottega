import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AiUsageService, usageDay } from './ai-usage.service.js';
import { worstCaseAiJobMs } from './ai-limits.js';

describe('usageDay', () => {
  it('uses the Buenos Aires calendar day (UTC-3), not the UTC one', () => {
    // 01:30 UTC on the 12th is still 22:30 on the 11th in Argentina.
    expect(usageDay(new Date('2026-10-12T01:30:00Z')).toISOString()).toBe(
      '2026-10-11T00:00:00.000Z',
    );
    expect(usageDay(new Date('2026-10-12T03:00:00Z')).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
  });
});

describe('worstCaseAiJobMs', () => {
  it('adds every model round, the sends and the overhead', () => {
    expect(
      worstCaseAiJobMs({
        OPENAI_TIMEOUT_MS: 20_000,
        WHATSAPP_HTTP_TIMEOUT_MS: 10_000,
      }),
    ).toBe(3 * 20_000 + 10_000 + 10_000);
  });
});

describe('AiUsageService.record', () => {
  it('stores the row for the local day and logs one content-free line', async () => {
    const create = vi
      .fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>()
      .mockResolvedValue({});
    const prisma = { aiUsage: { create } } as unknown as PrismaService;
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await new AiUsageService(prisma).record(
      {
        conversationId: 'conv-1',
        model: 'm',
        inputTokens: 12,
        outputTokens: 4,
        latencyMs: 321,
        outcome: 'OK',
      },
      new Date('2026-10-12T01:00:00Z'),
    );

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      conversationId: 'conv-1',
      day: new Date('2026-10-11T00:00:00Z'),
      outcome: 'OK',
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: 'ai_call',
      conversationId: 'conv-1',
      model: 'm',
      inputTokens: 12,
      outputTokens: 4,
      latencyMs: 321,
      outcome: 'OK',
    });
    log.mockRestore();
  });
});
