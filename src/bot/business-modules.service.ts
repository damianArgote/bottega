import { Injectable } from '@nestjs/common';
import {
  ActionCallerService,
  type ActionOutcome,
} from '../actions/action-caller.service.js';
import type { ActionParameters } from '../actions/action-parameters.js';
import { actionTools, type ActionsModule } from '../actions/action-tools.js';
import { AgentActionsService } from '../actions/agent-actions.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import {
  AgentActionKind,
  ConversationMode,
  type AgentAction,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BusinessModules } from './modules.js';

/** The bot turn the modules are for (business actions are called in it). */
export interface ModuleTurn {
  conversationId: string;
  /** The inbound message: a retried job gets the same idempotency keys. */
  messageId: string;
}

/** What a business action answers in the admin preview: never called. */
const PREVIEW_OUTCOME: ActionOutcome = {
  ok: true,
  status: null,
  result: {
    data: {
      vista_previa:
        'En la vista previa las acciones no se llaman: no hay resultado real.',
    },
  },
};

/**
 * The one place that decides which modules a business has on, and with
 * that which tools its agent gets (see MODULE_TOOLS). Modules belong to the
 * business: the fictitious demo never gets any.
 */
@Injectable()
export class BusinessModulesService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly actions: AgentActionsService,
    private readonly caller: ActionCallerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Without a `turn` (the admin preview) business actions are offered but
   * never called.
   */
  async forBusiness(
    businessId: string,
    mode: ConversationMode,
    turn?: ModuleTurn,
  ): Promise<BusinessModules> {
    if (mode !== ConversationMode.COMMERCIAL) {
      return {};
    }
    // catalog: on while the business has an available item.
    const catalog = await this.catalog.readerFor(businessId);
    // actions: on while it has an active action.
    const active = await this.actions.active(businessId);
    return {
      ...(catalog ? { catalog } : {}),
      ...(active.length > 0
        ? { actions: this.actionsModule(active, turn) }
        : {}),
    };
  }

  private actionsModule(
    active: AgentAction[],
    turn: ModuleTurn | undefined,
  ): ActionsModule {
    const byName = new Map(active.map((a) => [a.name, a]));
    const tools = actionTools(
      active.map((a) => ({
        name: a.name,
        description: a.description,
        parameters: a.parameters as ActionParameters,
        kind: a.kind === AgentActionKind.EFFECT ? 'effect' : 'query',
      })),
    );
    if (!turn) {
      return { tools, run: () => Promise.resolve(PREVIEW_OUTCOME) };
    }
    /** Calls of each action so far in this turn (part of the key). */
    const counts = new Map<string, number>();
    let contact: Promise<{ waId: string; name: string | null }> | undefined;
    return {
      tools,
      run: async (name, args) => {
        const action = byName.get(name)!;
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        contact ??= this.contactOf(turn.conversationId);
        return this.caller.call(action, {
          idempotencyKey: `${turn.messageId}:${name}:${n}`,
          conversationId: turn.conversationId,
          contact: await contact,
          arguments: args,
        });
      },
    };
  }

  /** Same as the 07a events: the operator's name, else Meta's profile name. */
  private async contactOf(conversationId: string) {
    const { contact } = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        contact: { select: { waId: true, name: true, profileName: true } },
      },
    });
    return { waId: contact.waId, name: contact.name ?? contact.profileName };
  }
}
