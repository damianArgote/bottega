import { echoReply } from './echo-replies.js';
import { RecentIds } from './recent-ids.js';

describe('echoReply', () => {
  it('quotes the received text', () => {
    expect(echoReply('hola')).toBe(
      'Hola! Soy Bottega 🤖 Recibí tu mensaje: "hola"',
    );
  });

  it('truncates long texts to 200 code points without splitting emoji', () => {
    const reply = echoReply('🍕'.repeat(250));

    expect(reply).toContain(`"${'🍕'.repeat(200)}…"`);
  });
});

describe('RecentIds', () => {
  it('detects duplicates and evicts the oldest id beyond capacity', () => {
    const ids = new RecentIds(2);

    expect(ids.add('a')).toBe(true);
    expect(ids.add('a')).toBe(false);
    ids.add('b');
    ids.add('c'); // evicts "a"

    expect(ids.add('b')).toBe(false);
    expect(ids.add('a')).toBe(true);
  });
});
