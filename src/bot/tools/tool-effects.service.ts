import type { ReplyButton } from '../../whatsapp/whatsapp.client.js';
import { Injectable } from '@nestjs/common';
import { HANDOFF_REASON_AI_MONTHLY_CAP } from '../../ai/ai-limits.service.js';
import type { Tx } from '../../conversations/context.service.js';
import { DemosService } from '../../demos/demos.service.js';
import type { LeadValues } from '../../leads/lead-values.js';
import { LeadsService } from '../../leads/leads.service.js';
import { CommandService, type CommandOutcome } from '../command.service.js';
import { CommandId } from '../commands.js';
import type { PlannedEffect } from './tool.js';

export const HANDOFF_REASON_AI_TOOL = 'ai_tool';

/** Replies and effects produced by the AI pipeline for one message. */
export interface GeneratedOutcome {
  contextId: string;
  replies: string[];
  effects: readonly PlannedEffect[];
  /** Reply buttons for the last reply (offer_options). */
  buttons?: ReplyButton[];
}

/**
 * Applies planned tool effects inside the job's phase-1 transaction, so they
 * commit atomically with the outbound replies and the inbound PROCESSED
 * marker (a retried job never applies them twice).
 */
@Injectable()
export class ToolEffectsService {
  constructor(
    private readonly leads: LeadsService,
    private readonly demos: DemosService,
    private readonly commands: CommandService,
  ) {}

  async apply(
    tx: Tx,
    conversationId: string,
    generated: GeneratedOutcome,
  ): Promise<CommandOutcome> {
    const lead: LeadValues = {};
    /** confirm: the "humano" confirmation follows the generated replies. */
    let handoff: { reason: string; confirm: boolean } | null = null;
    for (const effect of generated.effects) {
      switch (effect.kind) {
        case 'save_lead':
          Object.assign(lead, effect.values);
          break;
        case 'register_demo_request':
          await this.demos.registerDemoRequest(
            conversationId,
            generated.contextId,
            effect.scenario,
            effect.request,
            tx,
          );
          if (effect.handoffReason) {
            handoff = aiToolHandoff(effect.handoffReason);
          }
          break;
        case 'insurance_quote':
          // Prices for the reply only: nothing to store.
          break;
        case 'request_handoff':
          handoff = aiToolHandoff(effect.reason);
          break;
        case 'ai_monthly_cap_handoff':
          // The generated reply already tells the user a person answers.
          handoff = { reason: HANDOFF_REASON_AI_MONTHLY_CAP, confirm: false };
          break;
        case 'reply_buttons':
          // Sent with the reply (GeneratedOutcome.buttons): nothing to store.
          break;
        case 'out_of_hours_notice':
          await tx.conversation.update({
            where: { id: conversationId },
            data: { outOfHoursNoticeOn: new Date(`${effect.day}T00:00:00Z`) },
          });
          break;
      }
    }
    if (Object.keys(lead).length > 0) {
      await this.leads.upsertFromConversation(conversationId, lead, tx);
    }

    if (handoff) {
      // Same transition and fixed confirmation as the "humano" command,
      // after the backend-built replies (the demo's request summary).
      const outcome = await this.commands.apply(
        tx,
        conversationId,
        CommandId.REQUEST_HUMAN,
        { handoffReason: handoff.reason },
      );
      if (!handoff.confirm) {
        return { contextId: outcome.contextId, replies: generated.replies };
      }
      return {
        ...outcome,
        replies: [...generated.replies, ...outcome.replies],
      };
    }
    return {
      contextId: generated.contextId,
      replies: generated.replies,
      ...(generated.buttons ? { buttons: generated.buttons } : {}),
    };
  }
}

function aiToolHandoff(reason: string | null) {
  return {
    reason: reason
      ? `${HANDOFF_REASON_AI_TOOL}: ${reason}`
      : HANDOFF_REASON_AI_TOOL,
    confirm: true,
  };
}
