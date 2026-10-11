import { Logger } from '@nestjs/common';
import { UNSUPPORTED_REPLY } from './echo-replies.js';
import {
  EchoReplyGenerator,
  type ReplyInput,
  UnimplementedAiReplyGenerator,
} from './reply-generator.js';

const input = (type: ReplyInput['message']['type'], content: string) => ({
  conversationId: 'c1',
  contextId: 'ctx1',
  message: { id: 'm1', type, content },
});

describe('EchoReplyGenerator', () => {
  it('echoes text and hints on unsupported messages', async () => {
    const generator = new EchoReplyGenerator();

    expect(await generator.generate(input('TEXT', 'hola'))).toEqual([
      'Hola! Soy Bottega 🤖 Recibí tu mensaje: "hola"',
    ]);
    expect(await generator.generate(input('UNSUPPORTED', '[image]'))).toEqual([
      UNSUPPORTED_REPLY,
    ]);
  });
});

describe('UnimplementedAiReplyGenerator', () => {
  it('returns no replies and warns without message content', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const replies = await new UnimplementedAiReplyGenerator().generate(
      input('TEXT', 'private content'),
    );

    expect(replies).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('not implemented');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('private content');
    warn.mockRestore();
  });
});
