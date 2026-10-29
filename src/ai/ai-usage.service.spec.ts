import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AiUsageService, usageDay, usageMonth } from './ai-usage.service.js';
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

describe('usageMonth', () => {
  const month = (iso: string) => {
    const { label, start, end } = usageMonth(new Date(iso));
    return { label, start: start.toISOString(), end: end.toISOString() };
  };

  it('is already November at 00:30 on 1/11 in Argentina (03:30 UTC)', () => {
    expect(month('2026-11-01T03:30:00Z')).toEqual({
      label: '2026-11',
      start: '2026-11-01T00:00:00.000Z',
      end: '2026-12-01T00:00:00.000Z',
    });
  });

  it('is still October at 22:00 on 31/10 in Argentina (01:00 UTC on 1/11)', () => {
    expect(month('2026-11-01T01:00:00Z')).toEqual({
      label: '2026-10',
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z',
    });
  });

  it('ends December on the first of January', () => {
    expect(month('2026-12-15T12:00:00Z').end).toBe('2027-01-01T00:00:00.000Z');
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
        agentProfileVersion: 2,
      },
      new Date('2026-10-12T01:00:00Z'),
    );

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      conversationId: 'conv-1',
      day: new Date('2026-10-11T00:00:00Z'),
      outcome: 'OK',
      agentProfileVersion: 2,
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: 'ai_call',
      conversationId: 'conv-1',
      model: 'm',
      inputTokens: 12,
      outputTokens: 4,
      latencyMs: 321,
      outcome: 'OK',
      agentProfileVersion: 2,
    });
    log.mockRestore();
  });
});
