import { ConversationMode } from '../generated/prisma/client.js';
import type { ReplyKey } from './replies.js';

/** Tools the model may call (see tools/registry.ts). */
export type ToolName =
  'save_lead' | 'register_demo_request' | 'request_handoff';

/** Which editable content (see ContentService) feeds the mode's prompt. */
export type KnowledgeRef =
  { kind: 'commercial-info' } | { kind: 'demo'; scenario: 'barbershop' };

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
    allowedTools: ['save_lead', 'request_handoff'],
    knowledge: { kind: 'commercial-info' },
  },
  [ConversationMode.DEMO]: {
    mode: ConversationMode.DEMO,
    enterReply: 'ENTER_DEMO',
    resetReply: 'RESET_DEMO',
    allowedTools: ['register_demo_request', 'request_handoff'],
    knowledge: { kind: 'demo', scenario: 'barbershop' },
  },
};
