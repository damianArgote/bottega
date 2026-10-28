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
} from '../ai/ai.provider.js';
import { loadBusinessAgentProfile } from '../agents/agent-profile.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  runCommercialTurn,
  type TurnMessage,
  type TurnToolCall,
} from './commercial-turn.js';

export type PreviewMessage = TurnMessage;
export type PreviewToolCall = TurnToolCall;

export interface PreviewResult {
  /** What the bot would send. */
  reply: string;
  /** Reply buttons under it. */
  buttons: { id: string; title: string }[];
  toolCalls: PreviewToolCall[];
  model: string;
  agentProfileVersion: number | null;
  usage: { calls: number; inputTokens: number; outputTokens: number };
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
    let result;
    try {
      result = await runCommercialTurn({
        provider: this.provider,
        profile,
        defaultModel: this.config.get('OPENAI_MODEL') ?? '',
        maxOutputTokens: this.config.get('OPENAI_MAX_OUTPUT_TOKENS'),
        messages,
        onCall: (response, latencyMs) =>
          this.logger.log(
            JSON.stringify({
              event: 'ai_preview_call',
              businessId,
              model: response.model,
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              latencyMs,
            }),
          ),
      });
    } catch (error) {
      const code =
        error instanceof AiProviderError ? error.code : 'ai_unexpected';
      this.logger.warn(`AI preview failed business=${businessId} code=${code}`);
      throw new ServiceUnavailableException({
        message: 'The model call failed',
        code,
      });
    }
    return {
      reply: result.reply,
      buttons: result.buttons,
      toolCalls: result.toolCalls,
      model: result.model,
      agentProfileVersion: profile.version,
      usage: result.usage,
    };
  }
}
