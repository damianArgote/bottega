import { ConversationMode } from '../generated/prisma/client.js';
import type { ReplyKey } from './replies.js';

/** Tools the model may call (see tools/registry.ts). */
export type ToolName =
  | 'save_lead'
  | 'register_demo_request'
  | 'quote_insurance'
  | 'request_handoff'
  | 'offer_options'
  | 'search_catalog';

/**
 * Which editable content (see ContentService) feeds the mode's prompt. The
 * demo's scenario is the active context's (ConversationContext.demoScenario).
 */
export type KnowledgeRef = { kind: 'commercial-info' } | { kind: 'demo' };

/** Per-mode behavior, as data. Prompts are built in prompts.ts. */
export interface ModeProfile {
  mode: ConversationMode;
  /** Fixed reply sent when the conversation switches into this mode. */
  enterReply: ReplyKey;
  /** Fixed reply sent when the user resets a context of this mode. */
  resetReply: ReplyKey;
  allowedTools: readonly ToolName[];
  knowledge: KnowledgeRef;
}

export const MODE_PROFILES: Readonly<Record<ConversationMode, ModeProfile>> = {
  [ConversationMode.COMMERCIAL]: {
    mode: ConversationMode.COMMERCIAL,
    enterReply: 'EXIT_DEMO',
    resetReply: 'RESET_COMMERCIAL',
    allowedTools: [
      'save_lead',
      'search_catalog',
      'request_handoff',
      'offer_options',
    ],
    knowledge: { kind: 'commercial-info' },
  },
  [ConversationMode.DEMO]: {
    mode: ConversationMode.DEMO,
    enterReply: 'ENTER_DEMO',
    resetReply: 'RESET_DEMO',
    allowedTools: [
      'register_demo_request',
      'quote_insurance',
      'request_handoff',
      'offer_options',
    ],
    knowledge: { kind: 'demo' },
  },
};
