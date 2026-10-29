import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { AiOutcome } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { usageMonth } from './ai-usage.service.js';

/** HandoffRequest reason when the business reached its monthly AI cap. */
export const HANDOFF_REASON_AI_MONTHLY_CAP = 'ai_monthly_cap';

/** Percentages of the monthly cap logged once when a business crosses them. */
const CAP_THRESHOLDS = [80, 100] as const;

/** A business's own caps; null uses the environment default. */
export interface BusinessAiLimits {
  aiMonthlyCap: number | null;
  aiDailyCapPerConversation: number | null;
  /** Catalog items (prompt 10); null uses CATALOG_MAX_ITEMS_PER_BUSINESS. */
  catalogItemCap: number | null;
}

/** A PUT of the limits: the catalog cap is optional (absent: unchanged). */
export type BusinessLimitsUpdate = Omit<BusinessAiLimits, 'catalogItemCap'> & {
  catalogItemCap?: number | null;
};

/** The caps that apply to one conversation (defaults resolved). */
export interface ConversationAiLimits {
  businessId: string;
  monthlyCap: number;
  dailyCap: number;
}

export interface BusinessAiUsage {
  /** "2026-11" (calendar month in Argentina). */
  month: string;
  used: number;
  cap: number;
  percent: number;
  capReached: boolean;
}

const limitsSelect = {
  aiMonthlyCap: true,
  aiDailyCapPerConversation: true,
  catalogItemCap: true,
} as const;

/**
 * Per-business AI caps. Only the admin API changes them; a business's
 * people only read their usage.
 */
@Injectable()
export class AiLimitsService {
  private readonly logger = new Logger(AiLimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async get(businessId: string): Promise<BusinessAiLimits> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: limitsSelect,
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    return business;
  }

  async put(
    businessId: string,
    limits: BusinessLimitsUpdate,
  ): Promise<BusinessAiLimits> {
    await this.get(businessId);
    return this.prisma.business.update({
      where: { id: businessId },
      data: limits,
      select: limitsSelect,
    });
  }

  /** The month's usage against the business's monthly cap. */
  async usage(businessId: string, now = new Date()): Promise<BusinessAiUsage> {
    const cap = this.monthlyCap(await this.get(businessId));
    const used = await this.countMonth(businessId, now);
    return {
      month: usageMonth(now).label,
      used,
      cap,
      percent: Math.round((used * 100) / cap),
      capReached: used >= cap,
    };
  }

  /** Caps of the conversation's business; null if it does not exist. */
  async forConversation(
    conversationId: string,
  ): Promise<ConversationAiLimits | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        line: {
          select: { business: { select: { id: true, ...limitsSelect } } },
        },
      },
    });
    if (!conversation) {
      return null;
    }
    const business = conversation.line.business;
    return {
      businessId: business.id,
      monthlyCap: this.monthlyCap(business),
      dailyCap:
        business.aiDailyCapPerConversation ??
        this.config.get('AI_MAX_INTERACTIONS_PER_USER_PER_DAY'),
    };
  }

  /**
   * Model calls (OK or ERROR) of the business in the calendar month of `now`
   * (Argentina): every conversation's (through conversation and line) plus
   * the catalog's (column mapping, document extraction).
   */
  async countMonth(businessId: string, now = new Date()): Promise<number> {
    const { start, end } = usageMonth(now);
    const where = {
      day: { gte: start, lt: end },
      outcome: { in: [AiOutcome.OK, AiOutcome.ERROR] },
    };
    const [conversations, catalog] = await Promise.all([
      this.prisma.aiUsage.count({
        where: { ...where, conversation: { line: { businessId } } },
      }),
      this.prisma.catalogAiUsage.count({ where: { ...where, businessId } }),
    ]);
    return conversations + catalog;
  }

  /** The business's monthly cap (its own, or the environment default). */
  async monthlyCapOf(businessId: string): Promise<number> {
    return this.monthlyCap(await this.get(businessId));
  }

  /**
   * Whether the conversation was already handed off for the monthly cap in
   * the month of `now` (it is handed off once per month).
   */
  async monthlyCapHandoffDone(
    conversationId: string,
    now = new Date(),
  ): Promise<boolean> {
    const month = usageMonth(now);
    // The UTC day before the month's first day covers its first hours in
    // Argentina; the exact month is checked below.
    const since = new Date(month.start.getTime() - 24 * 60 * 60_000);
    const handoffs = await this.prisma.handoffRequest.findMany({
      where: {
        conversationId,
        reason: HANDOFF_REASON_AI_MONTHLY_CAP,
        createdAt: { gte: since },
      },
      select: { createdAt: true },
    });
    return handoffs.some((h) => usageMonth(h.createdAt).label === month.label);
  }

  /**
   * Logs the 80% and 100% thresholds the business crossed going from
   * `before` (counted before a turn) to `after` (counted after its calls).
   * Every call falls in some turn's range, so each threshold is logged once
   * a month (two concurrent turns may both log it).
   */
  logThresholds(
    businessId: string,
    cap: number,
    before: number,
    after: number,
  ): void {
    for (const percent of CAP_THRESHOLDS) {
      const threshold = Math.ceil((cap * percent) / 100);
      if (before < threshold && after >= threshold) {
        this.logger.log(
          JSON.stringify({
            event: 'ai_monthly_cap_threshold',
            businessId,
            percent,
            used: after,
            cap,
          }),
        );
      }
    }
  }

  private monthlyCap(business: BusinessAiLimits): number {
    return (
      business.aiMonthlyCap ??
      this.config.get('AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH')
    );
  }
}
