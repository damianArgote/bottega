import { ConversationMode } from '../generated/prisma/client.js';
import { CommandId } from './commands.js';
import { renderReply } from './replies.js';
import { planTransition, type TransitionPlan } from './transitions.js';

const { COMMERCIAL, DEMO } = ConversationMode;

describe('planTransition', () => {
  it.each<[ConversationMode, CommandId, TransitionPlan]>([
    [
      COMMERCIAL,
      CommandId.ENTER_DEMO,
      { effect: { kind: 'switch_mode', to: DEMO }, reply: 'ENTER_DEMO' },
    ],
    [
      DEMO,
      CommandId.ENTER_DEMO,
      { effect: { kind: 'none' }, reply: 'ALREADY_IN_DEMO' },
    ],
    [
      DEMO,
      CommandId.EXIT_DEMO,
      { effect: { kind: 'switch_mode', to: COMMERCIAL }, reply: 'EXIT_DEMO' },
    ],
    [
      COMMERCIAL,
      CommandId.EXIT_DEMO,
      { effect: { kind: 'none' }, reply: 'NOT_IN_DEMO' },
    ],
    [
      COMMERCIAL,
      CommandId.RESET,
      { effect: { kind: 'reset_context' }, reply: 'RESET_COMMERCIAL' },
    ],
    [
      DEMO,
      CommandId.RESET,
      { effect: { kind: 'reset_context' }, reply: 'RESET_DEMO' },
    ],
    [
      COMMERCIAL,
      CommandId.REQUEST_HUMAN,
      { effect: { kind: 'request_human' }, reply: 'HUMAN_REQUESTED' },
    ],
    [
      DEMO,
      CommandId.REQUEST_HUMAN,
      { effect: { kind: 'request_human' }, reply: 'HUMAN_REQUESTED' },
    ],
  ])('%s + %s', (mode, command, plan) => {
    expect(planTransition({ mode }, command)).toEqual(plan);
  });
});

describe('renderReply', () => {
  it('states the demo is fictitious, how to leave, and names the business', () => {
    const text = renderReply('ENTER_DEMO', { demoBusinessName: 'Barbería X' });

    expect(text).toContain('DEMO');
    expect(text).toContain('ficticios');
    expect(text).toContain('no se hacen reservas ni pagos reales');
    expect(text).toContain('"salir"');
    expect(text).toContain('Barbería X');
  });
});
