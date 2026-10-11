import { ConversationMode } from '../generated/prisma/client.js';
import { CommandId } from './commands.js';
import { MODE_PROFILES } from './mode-profiles.js';
import type { ReplyKey } from './replies.js';

/** State a transition is planned from. Paused conversations never get here. */
export interface TransitionState {
  mode: ConversationMode;
}

export type TransitionEffect =
  /** Close the active context and open a new one in `to`. */
  | { kind: 'switch_mode'; to: ConversationMode }
  /** Close the active context and open a new one in the same mode. */
  | { kind: 'reset_context' }
  /** Pause the bot and open a handoff request for the team. */
  | { kind: 'request_human' }
  /** Nothing changes; only the reply is sent. */
  | { kind: 'none' };

export interface TransitionPlan {
  effect: TransitionEffect;
  reply: ReplyKey;
}

/**
 * The only place that decides which mode/context/pause changes a command
 * causes. Pure: the caller applies the effect and persists the reply.
 */
export function planTransition(
  state: TransitionState,
  command: CommandId,
): TransitionPlan {
  const inDemo = state.mode === ConversationMode.DEMO;
  switch (command) {
    case CommandId.ENTER_DEMO:
      return inDemo
        ? { effect: { kind: 'none' }, reply: 'ALREADY_IN_DEMO' }
        : switchTo(ConversationMode.DEMO);
    case CommandId.EXIT_DEMO:
      return inDemo
        ? switchTo(ConversationMode.COMMERCIAL)
        : { effect: { kind: 'none' }, reply: 'NOT_IN_DEMO' };
    case CommandId.RESET:
      return {
        effect: { kind: 'reset_context' },
        reply: MODE_PROFILES[state.mode].resetReply,
      };
    case CommandId.REQUEST_HUMAN:
      return { effect: { kind: 'request_human' }, reply: 'HUMAN_REQUESTED' };
  }
}

function switchTo(to: ConversationMode): TransitionPlan {
  return {
    effect: { kind: 'switch_mode', to },
    reply: MODE_PROFILES[to].enterReply,
  };
}
