import { Logger } from '@nestjs/common';
import {
  AiProviderError,
  type AiInputItem,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../ai/ai.provider.js';
import { AI_MAX_MODEL_ROUNDS } from '../ai/ai-limits.js';
import type {
  AiLimitsService,
  ConversationAiLimits,
} from '../ai/ai-limits.service.js';
import type { AiUsageService } from '../ai/ai-usage.service.js';
import {
  type AgentProfile,
  loadAgentProfile,
} from '../agents/agent-profile.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { ContentService } from '../content/content.service.js';
import { AiOutcome, ConversationMode } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  AI_FALLBACK_REPLY,
  AI_LIMIT_REPLY,
  AI_MONTHLY_CAP_REPLY,
} from './ai-replies.js';
import {
  demoRequestReplies,
  finalReply,
  offeredButtons,
  runAgentTurn,
} from './agent-turn.js';
import type { DemoContent } from '../content/content.schema.js';
import { demoScenarioOf } from '../demos/demo-scenarios.js';
import { EXIT_DEMO_BUTTON } from './reply-buttons.js';
import { UNSUPPORTED_REPLY } from './echo-replies.js';
import { historyContextIds, historyWhere, toHistoryItems } from './history.js';
import { JobError } from './job-error.js';
import {
  buildCommercialInstructions,
  buildDemoInstructions,
} from './prompts.js';
import type {
  GeneratedReply,
  ReplyGenerator,
  ReplyInput,
} from './reply-generator.js';
import { leadValuesOf } from '../leads/lead-values.js';
import { isOpenAt, localDay } from '../agents/opening-hours.js';
import type { PlannedEffect } from './tools/tool.js';
import { isToolName, toolDefinitionsFor } from './tools/registry.js';

const fallback = (): GeneratedReply => ({
  replies: [AI_FALLBACK_REPLY],
  effects: [],
});

/** What every model call of one inbound message shares. */
interface Turn {
  input: ReplyInput;
  model: string;
  agentProfileVersion: number | null;
  /** Model calls made so far (each one counts for the monthly cap). */
  calls: number;
}

export interface AiReplyGeneratorDeps {
  /** Current time (tests); defaults to the system clock. */
  clock?: () => Date;
  provider: AiProvider;
  usage: AiUsageService;
  limits: AiLimitsService;
  catalog: CatalogService;
  prisma: PrismaService;
  content: ContentService;
  config: AppConfigService;
}

/**
 * BOT_REPLY_MODE=ai. For one inbound text:
 *
 * 0. Agent switched off (AgentProfile.enabled false, or no stored profile):
 *    no model call and no reply; the inbound message is already stored.
 * 1. Monthly cap: when the business's conversations already made its monthly
 *    cap of model calls (Business.aiMonthlyCap, else
 *    AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH; OK or ERROR, calendar month
 *    in America/Argentina/Buenos_Aires), no call is made: a LIMITED usage
 *    row is recorded and the conversation is handed off to a person with a
 *    fixed reply, once a month per conversation (afterwards, no reply).
 * 1b. Daily cap: when the conversation already made its daily cap of model
 *    calls today (Business.aiDailyCapPerConversation, else
 *    AI_MAX_INTERACTIONS_PER_USER_PER_DAY; same counting, Argentine day), no
 *    call is made: a LIMITED usage row is recorded and a fixed reply is
 *    returned.
 * 2. Builds the mode's instructions from the business's agent profile (its
 *    model, or OPENAI_MODEL) and the history of the active context. In
 *    commercial mode, a business with available catalog items also gets
 *    search_catalog (a read-only tool that queries during the loop).
 * 3. Runs up to {@link AI_MAX_MODEL_ROUNDS} model calls. Tool calls are
 *    validated and planned in memory (registry) and their results fed back;
 *    nothing is written here, effects are applied by the worker's phase-1
 *    transaction together with the replies.
 * 4. Failures: retryable errors with attempts left throw a retryable
 *    JobError (the queue backs off and the whole turn is regenerated);
 *    otherwise a controlled fallback reply with no effects.
 */
export class AiReplyGenerator implements ReplyGenerator {
  private readonly logger = new Logger(AiReplyGenerator.name);

  constructor(private readonly deps: AiReplyGeneratorDeps) {}

  async generate(input: ReplyInput): Promise<GeneratedReply> {
    const profile = await loadAgentProfile(
      this.deps.prisma,
      input.conversationId,
    );
    if (!profile.enabled) {
      // Switched off: the AI does not answer until the agent is turned on.
      return { replies: [], effects: [] };
    }
    if (input.message.type !== 'TEXT') {
      return { replies: [UNSUPPORTED_REPLY], effects: [] };
    }
    const { config, usage, limits } = this.deps;
    const turn: Turn = {
      input,
      model: profile.model ?? config.get('OPENAI_MODEL') ?? '',
      agentProfileVersion: profile.version,
      calls: 0,
    };
    const caps = await limits.forConversation(input.conversationId);
    if (!caps) {
      throw new JobError('conversation_missing', false);
    }
    // Usage rows are dated with the system clock (AiUsageService.record), so
    // the caps count with it too, not with the opening-hours clock.
    const usedThisMonth = await limits.countMonth(caps.businessId);
    if (usedThisMonth >= caps.monthlyCap) {
      await this.recordLimited(turn);
      if (await limits.monthlyCapHandoffDone(input.conversationId)) {
        // Handed off once this month already (a person gave the bot back).
        return { replies: [], effects: [] };
      }
      return {
        replies: [AI_MONTHLY_CAP_REPLY],
        effects: [{ kind: 'ai_monthly_cap_handoff' }],
      };
    }
    if ((await usage.countToday(input.conversationId)) >= caps.dailyCap) {
      await this.recordLimited(turn);
      return { replies: [AI_LIMIT_REPLY], effects: [] };
    }
    try {
      return await this.answer(input, profile, turn, caps.businessId);
    } finally {
      // Also after a retryable failure: its ERROR rows already count.
      if (turn.calls > 0) {
        await this.logThresholds(caps, usedThisMonth);
      }
    }
  }

  /**
   * Logs the monthly thresholds this turn crossed. The count is read again
   * after the turn's own rows, so concurrent turns of the business may both
   * log a threshold but never all miss it. A failure here only skips the log.
   */
  private async logThresholds(
    caps: ConversationAiLimits,
    before: number,
  ): Promise<void> {
    try {
      const after = await this.deps.limits.countMonth(caps.businessId);
      this.deps.limits.logThresholds(
        caps.businessId,
        caps.monthlyCap,
        before,
        after,
      );
    } catch {
      this.logger.warn(
        `Monthly AI usage count failed business=${caps.businessId}: threshold log skipped`,
      );
    }
  }

  private async recordLimited(turn: Turn): Promise<void> {
    await this.deps.usage.record({
      conversationId: turn.input.conversationId,
      model: turn.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      outcome: AiOutcome.LIMITED,
      agentProfileVersion: turn.agentProfileVersion,
    });
  }

  /** Steps 2 to 4: the model turn. */
  private async answer(
    input: ReplyInput,
    profile: AgentProfile,
    turn: Turn,
    businessId: string,
  ): Promise<GeneratedReply> {
    const { config } = this.deps;
    const items: AiInputItem[] = [
      ...(await this.history(input)),
      { kind: 'message', role: 'user', content: input.message.content },
    ];
    const demo = await this.demoOf(input);
    // The catalog belongs to the business: never inside the fictitious demo.
    const catalog =
      input.mode === ConversationMode.COMMERCIAL
        ? await this.deps.catalog.readerFor(businessId)
        : undefined;
    const toolOptions = {
      demoEnabled: profile.demoEnabled,
      leadFields: profile.leadFields,
      ...(demo ? { demo } : {}),
      ...(catalog ? { catalog } : {}),
    };
    const request = {
      model: turn.model,
      instructions: await this.instructions(input, profile, demo, !!catalog),
      tools: toolDefinitionsFor(input.mode, toolOptions),
      maxOutputTokens: config.get('OPENAI_MAX_OUTPUT_TOKENS'),
    };
    const names = {
      demoBusinessName: demo?.name ?? '',
      botName: profile.botName,
    };
    const outcome = await runAgentTurn(
      {
        request,
        input: items,
        tools: { mode: input.mode, ...toolOptions },
      },
      (r) => this.call(turn, r),
      (rejected) => {
        const tool = isToolName(rejected.name) ? rejected.name : 'unknown';
        this.logger.warn(
          `Tool call rejected conversation=${input.conversationId} tool=${tool} reason=${rejected.reason}`,
        );
      },
    );
    switch (outcome.kind) {
      case 'no_response':
        return fallback();
      case 'rounds_exceeded':
        this.logger.warn(
          `AI turn exceeded ${AI_MAX_MODEL_ROUNDS} rounds conversation=${input.conversationId}`,
        );
        return fallback();
      case 'handoff':
        // The handoff transition supplies the fixed confirmation reply,
        // after the demo request's summary (the insurance demo's close).
        return {
          replies: demoRequestReplies(outcome.effects, names),
          effects: outcome.effects,
        };
      case 'text': {
        const reply = finalReply(outcome.text, outcome.effects, names);
        if (!reply) {
          return fallback();
        }
        const notice = await this.outOfHoursNotice(input, profile);
        // Inside the demo every reply can leave it with a tap.
        const buttons =
          offeredButtons(outcome.effects) ??
          (input.mode === ConversationMode.DEMO
            ? [EXIT_DEMO_BUTTON]
            : undefined);
        return {
          replies: [notice ? `${reply}\n\n${notice.text}` : reply],
          effects: notice
            ? [...outcome.effects, notice.effect]
            : outcome.effects,
          ...(buttons ? { buttons } : {}),
        };
      }
    }
  }

  /**
   * The profile's out-of-hours message, in commercial mode, when the business
   * has opening hours,
   * it is closed now in its timezone and this conversation did not get the
   * notice today. The effect records the day in the job transaction.
   */
  private async outOfHoursNotice(
    input: ReplyInput,
    profile: AgentProfile,
  ): Promise<{ text: string; effect: PlannedEffect } | null> {
    // Commercial mode only: inside the demo role-play it would break the scene.
    if (
      input.mode !== ConversationMode.COMMERCIAL ||
      !profile.outOfHoursMessage ||
      !profile.openingHours
    ) {
      return null;
    }
    const conversation = await this.deps.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        outOfHoursNoticeOn: true,
        line: { select: { business: { select: { timezone: true } } } },
      },
    });
    if (!conversation) {
      return null;
    }
    const timezone = conversation.line.business.timezone;
    const now = this.deps.clock?.() ?? new Date();
    let day: string;
    try {
      if (isOpenAt(profile.openingHours, timezone, now)) {
        return null;
      }
      day = localDay(timezone, now);
    } catch {
      this.logger.warn(
        `Unknown business timezone conversation=${input.conversationId}: no out-of-hours notice`,
      );
      return null;
    }
    if (conversation.outOfHoursNoticeOn?.toISOString().slice(0, 10) === day) {
      return null;
    }
    return {
      text: profile.outOfHoursMessage,
      effect: { kind: 'out_of_hours_notice', day },
    };
  }

  /** One model call with its usage row. Null means "use the fallback". */
  private async call(
    turn: Turn,
    request: AiRequest,
  ): Promise<AiResponse | null> {
    const { input, model, agentProfileVersion } = turn;
    turn.calls += 1;
    const started = Date.now();
    let response: AiResponse;
    try {
      response = await this.deps.provider.respond(request);
    } catch (error) {
      const failure =
        error instanceof AiProviderError
          ? error
          : new AiProviderError('ai_unexpected', false);
      await this.deps.usage.record({
        conversationId: input.conversationId,
        model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        outcome: AiOutcome.ERROR,
        agentProfileVersion,
      });
      if (failure.retryable && !input.isLastAttempt) {
        throw new JobError(failure.code, true);
      }
      this.logger.warn(
        `AI call failed conversation=${input.conversationId} code=${failure.code}: using fallback reply`,
      );
      return null;
    }
    // Outside the try: a database error here is not a model failure and
    // propagates (the worker retries the job).
    await this.deps.usage.record({
      conversationId: input.conversationId,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      latencyMs: Date.now() - started,
      outcome: AiOutcome.OK,
      agentProfileVersion,
    });
    return response;
  }

  /** The fictitious business of the active DEMO context. */
  private async demoOf(input: ReplyInput): Promise<DemoContent | undefined> {
    if (input.mode !== ConversationMode.DEMO) {
      return undefined;
    }
    const context = await this.deps.prisma.conversationContext.findUnique({
      where: { id: input.contextId },
      select: { demoScenario: true },
    });
    return this.deps.content.getDemo(
      demoScenarioOf(context?.demoScenario ?? null),
    );
  }

  private async instructions(
    input: ReplyInput,
    profile: AgentProfile,
    demo: DemoContent | undefined,
    catalog: boolean,
  ): Promise<string> {
    const { prisma } = this.deps;
    if (demo) {
      // Isolation: no lead data and no business info in the demo prompt.
      return buildDemoInstructions(demo);
    }
    const lead = await prisma.lead.findUnique({
      where: { conversationId: input.conversationId },
    });
    return buildCommercialInstructions(profile, leadValuesOf(lead), {
      catalog,
    });
  }

  /**
   * Last AI_HISTORY_LIMIT messages the model remembers (see
   * historyContextIds), oldest first.
   */
  private async history(input: ReplyInput): Promise<AiInputItem[]> {
    const { prisma } = this.deps;
    const active = await prisma.conversationContext.findUnique({
      where: { id: input.contextId },
      select: { startedAt: true },
    });
    const contexts = await prisma.conversationContext.findMany({
      where: {
        conversationId: input.conversationId,
        startedAt: { lte: active?.startedAt ?? new Date() },
        id: { not: input.contextId },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, mode: true, endReason: true },
    });
    const contextIds = historyContextIds(input.mode, [
      { id: input.contextId, mode: input.mode, endReason: null },
      ...contexts,
    ]);
    const rows = await prisma.message.findMany({
      where: historyWhere(contextIds, input.message.id),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.deps.config.get('AI_HISTORY_LIMIT'),
      select: { direction: true, content: true },
    });
    return toHistoryItems(rows.reverse());
  }
}
