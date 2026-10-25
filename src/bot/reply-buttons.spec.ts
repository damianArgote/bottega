import {
  DEMO_BUTTON,
  EXIT_DEMO_BUTTON,
  MAX_BUTTON_TITLE,
  textButtons,
} from './reply-buttons.js';

describe('reply buttons', () => {
  it('a reply that invites to write "demo" or "salir" gets that button', () => {
    expect(textButtons('Si querés probarlo, escribí "demo".')).toEqual([
      DEMO_BUTTON,
    ]);
    expect(textButtons('Para volver, escribí "salir".')).toEqual([
      EXIT_DEMO_BUTTON,
    ]);
    expect(textButtons('Probá la demo o hablá con el equipo')).toEqual([]);
  });

  it('titles fit WhatsApp (20 characters) and are recognized as the commands', () => {
    for (const button of [DEMO_BUTTON, EXIT_DEMO_BUTTON]) {
      expect(button.title.length).toBeLessThanOrEqual(MAX_BUTTON_TITLE);
    }
  });
});
