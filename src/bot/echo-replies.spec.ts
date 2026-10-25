import { echoReply } from './echo-replies.js';

describe('echoReply', () => {
  it('quotes the received text', () => {
    expect(echoReply('hola')).toBe(
      'Hola! Soy BotSuite46 🤖 Recibí tu mensaje: "hola"',
    );
  });

  it('truncates long texts to 200 code points without splitting emoji', () => {
    const reply = echoReply('🍕'.repeat(250));

    expect(reply).toContain(`"${'🍕'.repeat(200)}…"`);
  });
});
