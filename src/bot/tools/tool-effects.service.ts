import { Injectable } from '@nestjs/common';
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
    let handoff: Extract<PlannedEffect, { kind: 'request_handoff' }> | null =
      null;
    for (const effect of generated.effects) {
      switch (effect.kind) {
        case 'save_lead':
          Object.assign(lead, effect.values);
          break;
        case 'register_demo_request':
          await this.demos.registerDemoRequest(
            conversationId,
            generated.contextId,
            effect.request,
            tx,
          );
          break;
        case 'request_handoff':
          handoff = effect;
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
      // Same transition and fixed confirmation as the "humano" command.
      return this.commands.apply(tx, conversationId, CommandId.REQUEST_HUMAN, {
        handoffReason: handoff.reason
          ? `${HANDOFF_REASON_AI_TOOL}: ${handoff.reason}`
          : HANDOFF_REASON_AI_TOOL,
      });
    }
    return { contextId: generated.contextId, replies: generated.replies };
  }
}
