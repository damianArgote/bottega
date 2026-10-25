import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AI_PROVIDER,
  AiProviderError,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../ai/ai.provider.js';
import { loadBusinessAgentProfile } from '../agents/agent-profile.js';
import { AppConfigService } from '../config/app-config.service.js';
import { ContentService } from '../content/content.service.js';
import { ConversationMode } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AI_FALLBACK_REPLY } from './ai-replies.js';
import { finalReply, runAgentTurn } from './agent-turn.js';
import { buildCommercialInstructions } from './prompts.js';
import { renderReply } from './replies.js';
import { toolDefinitionsFor } from './tools/registry.js';

export interface PreviewMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PreviewToolCall {
  name: string;
  /** The model's arguments, parsed when they are valid JSON. */
  arguments: unknown;
  accepted: boolean;
  reason?: string;
}

export interface PreviewResult {
  /** What the bot would send. */
  reply: string;
  toolCalls: PreviewToolCall[];
  model: string;
  agentProfileVersion: number | null;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * POST /admin/businesses/:id/agent/preview: one commercial turn of the
 * business's agent against the real model, from the given messages. Nothing
 * is sent by WhatsApp and nothing is stored (no messages, lead, handoff or
 * usage rows): tool calls are only reported. Works with the agent switched
 * off, to try it before turning it on. Costs a real model call; logs one
 * content-free line per call.
 */
@Injectable()
export class AgentPreviewService {
  private readonly logger = new Logger(AgentPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly config: AppConfigService,
    private readonly content: ContentService,
  ) {}

  async run(
    businessId: string,
    messages: readonly PreviewMessage[],
  ): Promise<PreviewResult> {
    const profile = await loadBusinessAgentProfile(this.prisma, businessId);
    if (profile === undefined) {
      throw new NotFoundException('Business not found');
    }
    if (profile === null) {
      throw new NotFoundException('Agent profile not found');
    }
    const model = profile.model ?? this.config.get('OPENAI_MODEL') ?? '';
    const toolOptions = {
      demoEnabled: profile.demoEnabled,
      leadFields: profile.leadFields,
    };
    const mode = ConversationMode.COMMERCIAL;
    const barbershop = this.content.getBarbershop();
    const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

    const call = async (request: AiRequest): Promise<AiResponse> => {
      const started = Date.now();
      const response = await this.provider.respond(request);
      usage.calls += 1;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      this.logger.log(
        JSON.stringify({
          event: 'ai_preview_call',
          businessId,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          latencyMs: Date.now() - started,
        }),
      );
      return response;
    };

    let outcome;
    try {
      outcome = await runAgentTurn(
        {
          request: {
            model,
            instructions: buildCommercialInstructions(profile, {}),
            tools: toolDefinitionsFor(mode, toolOptions),
            maxOutputTokens: this.config.get('OPENAI_MAX_OUTPUT_TOKENS'),
          },
          input: messages.map((m) => ({ kind: 'message', ...m })),
          tools: { mode, barbershop, ...toolOptions },
        },
        call,
      );
    } catch (error) {
      const code =
        error instanceof AiProviderError ? error.code : 'ai_unexpected';
      this.logger.warn(`AI preview failed business=${businessId} code=${code}`);
      throw new ServiceUnavailableException({
        message: 'The model call failed',
        code,
      });
    }

    const names = {
      demoBusinessName: barbershop.name,
      botName: profile.botName,
    };
    const reply =
      outcome.kind === 'handoff'
        ? renderReply('HUMAN_REQUESTED', names)
        : outcome.kind === 'text'
          ? (finalReply(outcome.text, outcome.effects, names) ??
            AI_FALLBACK_REPLY)
          : AI_FALLBACK_REPLY;
    return {
      reply,
      toolCalls: outcome.calls.map((c) => ({
        name: c.name,
        arguments: parseArguments(c.arguments),
        accepted: c.accepted,
        ...(c.reason ? { reason: c.reason } : {}),
      })),
      model,
      agentProfileVersion: profile.version,
      usage,
    };
  }
}
