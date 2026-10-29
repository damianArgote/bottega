import { Injectable, Logger } from '@nestjs/common';
import { AiOutcome } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The daily cap resets at midnight in Argentina, where the users are, not at
 * UTC midnight (21:00 local time). Argentina has no DST, but the IANA zone is
 * used anyway so the rule stays correct if that changes.
 */
export const USAGE_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: USAGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Calendar day of `now` in {@link USAGE_TIME_ZONE}, as a UTC-midnight Date
 * (the representation Prisma uses for `@db.Date` columns).
 */
export function usageDay(now: Date): Date {
  return new Date(`${dayFormat.format(now)}T00:00:00.000Z`);
}

/** A calendar month in {@link USAGE_TIME_ZONE}. */
export interface UsageMonth {
  /** "2026-11". */
  label: string;
  /** First day of the month, as a usage day (UTC-midnight Date). */
  start: Date;
  /** First day of the next month (exclusive end). */
  end: Date;
}

/** Calendar month of `now` in {@link USAGE_TIME_ZONE}. */
export function usageMonth(now: Date): UsageMonth {
  const label = dayFormat.format(now).slice(0, 7);
  const start = new Date(`${label}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { label, start, end };
}

export interface AiUsageRecord {
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: AiOutcome;
  /** Version of the agent profile used; null without a stored profile. */
  agentProfileVersion: number | null;
}

/** AI call accounting (never stores or logs message content). */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Model calls (OK or ERROR) made today for the conversation. */
  countToday(conversationId: string, now = new Date()): Promise<number> {
    return this.prisma.aiUsage.count({
      where: {
        conversationId,
        day: usageDay(now),
        outcome: { in: [AiOutcome.OK, AiOutcome.ERROR] },
      },
    });
  }

  /** Stores the usage row and logs one structured, content-free line. */
  async record(entry: AiUsageRecord, now = new Date()): Promise<void> {
    await this.prisma.aiUsage.create({
      data: { ...entry, day: usageDay(now) },
    });
    this.logger.log(
      JSON.stringify({
        event: 'ai_call',
        conversationId: entry.conversationId,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        latencyMs: entry.latencyMs,
        outcome: entry.outcome,
        agentProfileVersion: entry.agentProfileVersion,
      }),
    );
  }
}
