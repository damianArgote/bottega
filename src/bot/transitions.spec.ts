import { ConversationMode } from '../generated/prisma/client.js';
import { CommandId } from './commands.js';
import { DEMO_SCENARIO_BUTTONS } from './reply-buttons.js';
import { renderReply, replyButtons } from './replies.js';
import { matchCommand } from './commands.js';
import { planTransition, type TransitionPlan } from './transitions.js';

const { COMMERCIAL, DEMO } = ConversationMode;

describe('planTransition', () => {
  it.each<[ConversationMode, CommandId, TransitionPlan]>([
    [
      COMMERCIAL,
      CommandId.ENTER_DEMO,
      { effect: { kind: 'none' }, reply: 'CHOOSE_DEMO' },
    ],
    [
      COMMERCIAL,
      CommandId.START_INSURANCE_DEMO,
      {
        effect: { kind: 'start_demo', scenario: 'insurance' },
        reply: 'ENTER_DEMO',
      },
    ],
    [
      DEMO,
      CommandId.START_BARBERSHOP_DEMO,
      {
        effect: { kind: 'start_demo', scenario: 'barbershop' },
        reply: 'ENTER_DEMO',
      },
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

  it.each([
    CommandId.ENTER_DEMO,
    CommandId.START_INSURANCE_DEMO,
    CommandId.EXIT_DEMO,
  ])('%s answers that there is no demo and changes nothing', (command) => {
    expect(planTransition(state, command)).toEqual({
      effect: { kind: 'none' },
      reply: 'DEMO_UNAVAILABLE',
    });
  });

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

  it('EXIT_DEMO says the user is back with the business bot and asks what they thought of the demo', () => {
    const text = renderReply('EXIT_DEMO', vars);

    expect(text).toContain('Volviste a hablar con Lola, IA de Lola');
    expect(text).toContain('¿Qué te pareció la demo?');
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
    expect(text).toContain('tocá el botón');
    expect(text).not.toContain('"salir"');
    expect(text).toContain('Barbería X');
  });
});

describe('demo picker', () => {
  it('CHOOSE_DEMO offers one button per scenario, each a start command', () => {
    const buttons = replyButtons('CHOOSE_DEMO');

    expect(buttons).toEqual([
      DEMO_SCENARIO_BUTTONS.insurance,
      DEMO_SCENARIO_BUTTONS.barbershop,
    ]);
    expect(buttons.map((b) => matchCommand(b.title))).toEqual([
      CommandId.START_INSURANCE_DEMO,
      CommandId.START_BARBERSHOP_DEMO,
    ]);
  });

  it('the insurance demo says quotes are simulated and asks what they want', () => {
    const text = renderReply('ENTER_DEMO', {
      demoBusinessName: 'VAL-RAM Seguros',
      demoScenario: 'insurance',
      botName: 'Lola',
    });

    expect(text).toContain('VAL-RAM Seguros');
    expect(text).toContain('cotizaciones son simulados');
    expect(text).toContain('no se emiten pólizas ni se cobran pagos');
    expect(text).toContain(
      '¿Querés asegurar un auto o comparar lo que estás pagando?',
    );
    expect(text).not.toContain('barbería');
  });

  it('RESET_DEMO names the demo business it stays in', () => {
    expect(
      renderReply('RESET_DEMO', {
        demoBusinessName: 'VAL-RAM Seguros',
        botName: 'Lola',
      }),
    ).toContain('VAL-RAM Seguros');
  });
});
