import { ConversationMode } from '../generated/prisma/client.js';
import type { DemoScenario } from '../demos/demo-scenarios.js';
import { CommandId, DEMO_START_COMMANDS } from './commands.js';
import { MODE_PROFILES } from './mode-profiles.js';
import type { ReplyKey } from './replies.js';

/** State a transition is planned from. Paused conversations never get here. */
export interface TransitionState {
  mode: ConversationMode;
  /** The business's profile offers the demo. */
  demoEnabled: boolean;
}

export type TransitionEffect =
  /** Close the active context and open a new one in `to`. */
  | { kind: 'switch_mode'; to: ConversationMode }
  /** Close the active context and open a DEMO one running `scenario`. */
  | { kind: 'start_demo'; scenario: DemoScenario }
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
  // Leaving still works if the demo was disabled while the user was in it.
  if (
    !state.demoEnabled &&
    !inDemo &&
    (command === CommandId.ENTER_DEMO ||
      command === CommandId.EXIT_DEMO ||
      command in DEMO_START_COMMANDS)
  ) {
    return { effect: { kind: 'none' }, reply: 'DEMO_UNAVAILABLE' };
  }
  switch (command) {
    case CommandId.START_INSURANCE_DEMO:
    case CommandId.START_AESTHETICS_DEMO:
      // Also from inside a demo: switches to the chosen one, from scratch.
      return {
        effect: { kind: 'start_demo', scenario: DEMO_START_COMMANDS[command] },
        reply: MODE_PROFILES[ConversationMode.DEMO].enterReply,
      };
    case CommandId.ENTER_DEMO:
      return inDemo
        ? { effect: { kind: 'none' }, reply: 'ALREADY_IN_DEMO' }
        : { effect: { kind: 'none' }, reply: 'CHOOSE_DEMO' };
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
