import type { ReplyButton } from '../whatsapp/whatsapp.client.js';
import { Injectable } from '@nestjs/common';
import { loadAgentProfile } from '../agents/agent-profile.js';
import { ContentService } from '../content/content.service.js';
import { ContextService, type Tx } from '../conversations/context.service.js';
import { type DemoScenario, demoScenarioOf } from '../demos/demo-scenarios.js';
import { ConversationMode } from '../generated/prisma/client.js';
import type { CommandId } from './commands.js';
import { renderReply, replyButtons } from './replies.js';
import { planTransition } from './transitions.js';

export const HANDOFF_REASON_USER_COMMAND = 'user_command';

export interface CommandOptions {
  /** HandoffRequest reason for REQUEST_HUMAN (defaults to the user command). */
  handoffReason?: string;
}

export interface CommandOutcome {
  /** Context the replies belong to (the new one after a context change). */
  contextId: string;
  replies: string[];
  /** Explicit buttons for the last reply (else derived from its text). */
  buttons?: ReplyButton[];
}

/** Applies a deterministic command planned by {@link planTransition}. */
@Injectable()
export class CommandService {
  constructor(
    private readonly contexts: ContextService,
    private readonly content: ContentService,
  ) {}

  /**
   * Runs inside the caller's transaction, so the change commits atomically
   * with the inbound phase marker and the persisted replies.
   */
  async apply(
    tx: Tx,
    conversationId: string,
    command: CommandId,
    options: CommandOptions = {},
  ): Promise<CommandOutcome> {
    const conversation = await this.contexts.lock(tx, conversationId);
    const { demoEnabled, botName } = await loadAgentProfile(tx, conversationId);
    const plan = planTransition(
      { mode: conversation.mode, demoEnabled },
      command,
    );

    let contextId = conversation.activeContextId;
    switch (plan.effect.kind) {
      case 'switch_mode':
        contextId = await this.contexts.switchMode(
          conversationId,
          plan.effect.to,
          tx,
        );
        break;
      case 'start_demo':
        contextId = await this.contexts.switchMode(
          conversationId,
          ConversationMode.DEMO,
          tx,
          plan.effect.scenario,
        );
        break;
      case 'reset_context':
        contextId = await this.contexts.resetContext(conversationId, tx);
        break;
      case 'request_human':
        await this.contexts.requestHuman(
          conversationId,
          options.handoffReason ?? HANDOFF_REASON_USER_COMMAND,
          tx,
        );
        break;
      case 'none':
        break;
    }
    if (!contextId) {
      throw new Error(`conversation ${conversationId} has no active context`);
    }

    // The demo the reply talks about: the one entered, or the active one.
    const demoScenario =
      plan.effect.kind === 'start_demo'
        ? plan.effect.scenario
        : conversation.mode === ConversationMode.DEMO
          ? await this.activeDemoScenario(tx, contextId)
          : undefined;
    const reply = renderReply(plan.reply, {
      demoBusinessName: demoScenario
        ? this.content.getDemo(demoScenario).name
        : '',
      botName,
      ...(demoScenario ? { demoScenario } : {}),
    });
    return {
      contextId,
      replies: [reply],
      buttons: replyButtons(plan.reply),
    };
  }

  private async activeDemoScenario(
    tx: Tx,
    contextId: string,
  ): Promise<DemoScenario> {
    const context = await tx.conversationContext.findUnique({
      where: { id: contextId },
      select: { demoScenario: true },
    });
    return demoScenarioOf(context?.demoScenario ?? null);
  }
}
