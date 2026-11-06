import { UNSUPPORTED_REPLY } from './echo-replies.js';
import { EchoReplyGenerator, type ReplyInput } from './reply-generator.js';

const input = (
  type: ReplyInput['message']['type'],
  content: string,
): ReplyInput => ({
  conversationId: 'c1',
  mode: 'COMMERCIAL',
  contextId: 'ctx1',
  message: { id: 'm1', type, content },
  isLastAttempt: false,
});

describe('EchoReplyGenerator', () => {
  it('echoes the texts of a burst in one reply', async () => {
    const generated = await new EchoReplyGenerator().generate({
      ...input('TEXT', 'hola'),
      grouped: [
        { id: 'm2', type: 'UNSUPPORTED', content: '[image]' },
        { id: 'm3', type: 'TEXT', content: 'quiero precio' },
      ],
    });
    expect(generated.replies).toEqual([
      'Hola! Soy BotSuite46 🤖 Recibí tu mensaje: "hola\nquiero precio"',
    ]);
  });

  it('echoes text and hints on unsupported messages, with no effects', async () => {
    const generator = new EchoReplyGenerator();

    expect(await generator.generate(input('TEXT', 'hola'))).toEqual({
      replies: ['Hola! Soy BotSuite46 🤖 Recibí tu mensaje: "hola"'],
      effects: [],
    });
    expect(await generator.generate(input('UNSUPPORTED', '[image]'))).toEqual({
      replies: [UNSUPPORTED_REPLY],
      effects: [],
    });
  });
});
