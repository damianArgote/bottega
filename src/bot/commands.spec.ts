import { CommandId, matchCommand } from './commands.js';

describe('matchCommand', () => {
  it.each([
    ['demo', CommandId.ENTER_DEMO],
    ['  DEMO  ', CommandId.ENTER_DEMO],
    ['Demo!', CommandId.ENTER_DEMO],
    ['¡Probar   demo! 🚀', CommandId.ENTER_DEMO],
    ['salir', CommandId.EXIT_DEMO],
    ['Salir de la demo.', CommandId.EXIT_DEMO],
    ['👋 salir 👋', CommandId.EXIT_DEMO],
    // The titles of the reply buttons (reply-buttons.ts).
    ['🧪 Probar la demo', CommandId.ENTER_DEMO],
    ['👋 Salir de la demo', CommandId.EXIT_DEMO],
    ['🚗 Seguro de auto', CommandId.START_INSURANCE_DEMO],
    ['💈 Barbería', CommandId.START_BARBERSHOP_DEMO],
    ['Reiniciar', CommandId.RESET],
    ['reinicíar', CommandId.RESET],
    ['HUMANO?', CommandId.REQUEST_HUMAN],
    ['húmano', CommandId.REQUEST_HUMAN],
    ['¿Hablar con una persona?', CommandId.REQUEST_HUMAN],
    ['hablar\ncon una\tpersona', CommandId.REQUEST_HUMAN],
  ])('matches %j as %s', (text, command) => {
    expect(matchCommand(text)).toBe(command);
  });

  it.each([
    'quiero probar la demo de mañana',
    'demos',
    'la demo',
    'salir ya',
    'no quiero salir',
    'reiniciar todo',
    'humanos',
    'hablar con persona',
    'salir, de la demo',
    'quiero un seguro de auto',
    '',
    '   ',
    '🚀',
  ])('does not match %j', (text) => {
    expect(matchCommand(text)).toBeNull();
  });
});
