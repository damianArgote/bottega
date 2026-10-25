import { Logger } from '@nestjs/common';
import {
  AiProviderError,
  type AiInputItem,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../ai/ai.provider.js';
import { AI_MAX_MODEL_ROUNDS } from '../ai/ai-limits.js';
import type { AiUsageService } from '../ai/ai-usage.service.js';
import {
  type AgentProfile,
  loadAgentProfile,
} from '../agents/agent-profile.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { ContentService } from '../content/content.service.js';
import { AiOutcome, ConversationMode } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  AI_FALLBACK_REPLY,
  AI_LIMIT_REPLY,
  demoRequestSummary,
  LEAD_SAVED_ACK,
} from './ai-replies.js';
import { UNSUPPORTED_REPLY } from './echo-replies.js';
import { historyWhere, toHistoryItems } from './history.js';
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
import {
  planToolCall,
  TOOL_HANDLERS,
  toolDefinitionsFor,
} from './tools/registry.js';
import type { PlannedEffect } from './tools/tool.js';

/** WhatsApp allows 4096 characters; keep model text well below it. */
const MAX_REPLY_CHARS = 3000;

const fallback = (): GeneratedReply => ({
  replies: [AI_FALLBACK_REPLY],
  effects: [],
});

/** What every model call of one inbound message shares. */
interface Turn {
  input: ReplyInput;
  model: string;
  agentProfileVersion: number | null;
}

export interface AiReplyGeneratorDeps {
  provider: AiProvider;
  usage: AiUsageService;
  prisma: PrismaService;
  content: ContentService;
  config: AppConfigService;
}

/**
 * BOT_REPLY_MODE=ai. For one inbound text:
 *
 * 1. Daily cap: when the conversation already made
 *    AI_MAX_INTERACTIONS_PER_USER_PER_DAY model calls today (OK or ERROR,
 *    day in America/Argentina/Buenos_Aires), no call is made: a LIMITED usage
 *    row is recorded and a fixed reply is returned.
 * 2. Builds the mode's instructions from the business's agent profile (its
 *    model, or OPENAI_MODEL) and the history of the active context.
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
    if (input.message.type !== 'TEXT') {
      return { replies: [UNSUPPORTED_REPLY], effects: [] };
    }
    const { config, usage } = this.deps;
    const profile = await loadAgentProfile(
      this.deps.prisma,
      input.conversationId,
    );
    const turn: Turn = {
      input,
      model: profile.model ?? config.get('OPENAI_MODEL') ?? '',
      agentProfileVersion: profile.version,
    };
    const cap = config.get('AI_MAX_INTERACTIONS_PER_USER_PER_DAY');
    if ((await usage.countToday(input.conversationId)) >= cap) {
      await usage.record({
        conversationId: input.conversationId,
        model: turn.model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        outcome: AiOutcome.LIMITED,
        agentProfileVersion: turn.agentProfileVersion,
      });
      return { replies: [AI_LIMIT_REPLY], effects: [] };
    }

    const items: AiInputItem[] = [
      ...(await this.history(input)),
      { kind: 'message', role: 'user', content: input.message.content },
    ];
    const { demoEnabled } = profile;
    const request = {
      model: turn.model,
      instructions: await this.instructions(input, profile),
      tools: toolDefinitionsFor(input.mode, { demoEnabled }),
      maxOutputTokens: config.get('OPENAI_MAX_OUTPUT_TOKENS'),
    };
    const barbershop = this.deps.content.getBarbershop();
    const effects: PlannedEffect[] = [];

    for (let round = 1; round <= AI_MAX_MODEL_ROUNDS; round += 1) {
      const response = await this.call(turn, {
        ...request,
        input: [...items],
      });
      if (!response) {
        return fallback();
      }
      if (response.toolCalls.length === 0) {
        return this.finish(response.outputText, effects);
      }
      for (const call of response.toolCalls) {
        const result = planToolCall(call, {
          mode: input.mode,
          barbershop,
          planned: effects,
          demoEnabled,
        });
        items.push(
          { kind: 'tool_call', ...call },
          { kind: 'tool_result', callId: call.callId, output: result.output },
        );
        if (result.ok) {
          effects.push(result.effect);
        } else {
          const tool = Object.hasOwn(TOOL_HANDLERS, call.name)
            ? call.name
            : 'unknown';
          this.logger.warn(
            `Tool call rejected conversation=${input.conversationId} tool=${tool} reason=${result.reason}`,
          );
        }
      }
      if (effects.some((e) => e.kind === 'request_handoff')) {
        // The handoff transition supplies the fixed confirmation reply.
        return { replies: [], effects };
      }
    }
    this.logger.warn(
      `AI turn exceeded ${AI_MAX_MODEL_ROUNDS} rounds conversation=${input.conversationId}`,
    );
    return fallback();
  }

  /** One model call with its usage row. Null means "use the fallback". */
  private async call(
    { input, model, agentProfileVersion }: Turn,
    request: AiRequest,
  ): Promise<AiResponse | null> {
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

  /** Final reply: model text plus backend-built confirmations. */
  private finish(text: string, effects: PlannedEffect[]): GeneratedReply {
    const parts: string[] = [];
    const chars = Array.from(text.trim());
    if (chars.length > 0) {
      parts.push(
        chars.length > MAX_REPLY_CHARS
          ? `${chars.slice(0, MAX_REPLY_CHARS).join('')}…`
          : chars.join(''),
      );
    }
    const name = this.deps.content.getBarbershop().name;
    for (const effect of effects) {
      if (effect.kind === 'register_demo_request') {
        parts.push(demoRequestSummary(effect.request, name));
      }
    }
    if (parts.length === 0) {
      if (!effects.some((e) => e.kind === 'save_lead')) {
        return fallback();
      }
      parts.push(LEAD_SAVED_ACK);
    }
    return { replies: [parts.join('\n\n')], effects };
  }

  private async instructions(
    input: ReplyInput,
    profile: AgentProfile,
  ): Promise<string> {
    const { content, prisma } = this.deps;
    if (input.mode === ConversationMode.DEMO) {
      // Isolation: no lead data and no business info in the demo prompt.
      return buildDemoInstructions(content.getBarbershop());
    }
    const lead = await prisma.lead.findUnique({
      where: { conversationId: input.conversationId },
    });
    return buildCommercialInstructions(profile, {
      // Until Lead.data exists (02b T3), the known values come from the
      // fixed lead columns.
      name: lead?.name,
      business_name: lead?.businessName,
      industry: lead?.industry,
      need: lead?.need,
    });
  }

  /** Last AI_HISTORY_LIMIT messages of the active context, oldest first. */
  private async history(input: ReplyInput): Promise<AiInputItem[]> {
    const rows = await this.deps.prisma.message.findMany({
      where: historyWhere(input.contextId, input.message.id),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.deps.config.get('AI_HISTORY_LIMIT'),
      select: { direction: true, content: true },
    });
    return toHistoryItems(rows.reverse());
  }
}
