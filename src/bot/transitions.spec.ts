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
    expect(planTransition({ mode, demoEnabled: true }, command)).toEqual(plan);
  });
});

describe('planTransition without the demo (demoEnabled false)', () => {
  const state = { mode: COMMERCIAL, demoEnabled: false };

  it.each([CommandId.ENTER_DEMO, CommandId.EXIT_DEMO])(
    '%s answers that there is no demo and changes nothing',
    (command) => {
      expect(planTransition(state, command)).toEqual({
        effect: { kind: 'none' },
        reply: 'DEMO_UNAVAILABLE',
      });
    },
  );

  it('still lets a conversation already in the demo leave it', () => {
    expect(
      planTransition({ mode: DEMO, demoEnabled: false }, CommandId.EXIT_DEMO),
    ).toEqual({
      effect: { kind: 'switch_mode', to: COMMERCIAL },
      reply: 'EXIT_DEMO',
    });
  });

  it('keeps reset and handoff', () => {
    expect(planTransition(state, CommandId.RESET).effect).toEqual({
      kind: 'reset_context',
    });
    expect(planTransition(state, CommandId.REQUEST_HUMAN).effect).toEqual({
      kind: 'request_human',
    });
  });
});

describe('renderReply', () => {
  const vars = { demoBusinessName: 'Barbería X', botName: 'Lola, IA de Lola' };

  it.each(['HUMAN_REQUESTED', 'EXIT_DEMO', 'RESET_COMMERCIAL'] as const)(
    '%s names no business of its own',
    (key) => {
      expect(renderReply(key, vars)).not.toContain('BotSuite');
    },
  );

  it('EXIT_DEMO says the user is back with the business bot', () => {
    expect(renderReply('EXIT_DEMO', vars)).toContain(
      'Volviste a hablar con Lola, IA de Lola',
    );
  });

  it('DEMO_UNAVAILABLE does not invite to a demo', () => {
    const text = renderReply('DEMO_UNAVAILABLE', {
      ...vars,
      demoBusinessName: 'X',
    });

    expect(text).not.toContain('"demo"');
    expect(text).not.toContain('X');
  });

  it('states the demo is fictitious, how to leave, and names the business', () => {
    const text = renderReply('ENTER_DEMO', {
      ...vars,
      demoBusinessName: 'Barbería X',
    });

    expect(text).toContain('DEMO');
    expect(text).toContain('ficticios');
    expect(text).toContain('no se hacen reservas ni pagos reales');
    expect(text).toContain('"salir"');
    expect(text).toContain('Barbería X');
  });
});
