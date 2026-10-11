import { Logger } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Env } from '../config/env.schema.js';
import type { InboundEvent } from './inbound-event.js';
import { InboundDispatcher } from './inbound.dispatcher.js';

const text: InboundEvent = {
  kind: 'text',
  waMessageId: 'wamid.1',
  from: '5491100001234',
  timestamp: new Date(0),
  text: 'private message content',
};

function createDispatcher(mode: Env['BOT_REPLY_MODE']) {
  const config = {
    get: (key: keyof Env) => (key === 'BOT_REPLY_MODE' ? mode : undefined),
  } as unknown as AppConfigService;
  const sendText = vi
    .fn()
    .mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out' });
  return { dispatcher: new InboundDispatcher(config, { sendText }), sendText };
}

describe('InboundDispatcher', () => {
  const logged: string[] = [];

  beforeEach(() => {
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logged.push(String(message));
        },
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not process events synchronously inside accept()', async () => {
    const { dispatcher, sendText } = createDispatcher('echo');

    dispatcher.accept([text]);

    expect(sendText).not.toHaveBeenCalled();
    await dispatcher.whenIdle();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and warns in ai mode (not implemented yet)', async () => {
    const { dispatcher, sendText } = createDispatcher('ai');

    dispatcher.accept([text]);
    await dispatcher.whenIdle();

    expect(sendText).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('BOT_REPLY_MODE=ai is not implemented');
  });

  it('never logs message content or full phone numbers', async () => {
    const { dispatcher } = createDispatcher('echo');

    dispatcher.accept([
      text,
      {
        kind: 'status',
        waMessageId: 'wamid.out',
        status: 'failed',
        recipientId: '5491100001234',
        timestamp: new Date(0),
        errors: [{ code: 131047 }],
      },
    ]);
    await dispatcher.whenIdle();

    const output = logged.join('\n');
    expect(output).not.toContain('private message content');
    expect(output).not.toContain('5491100001234');
    expect(output).toContain('***1234');
  });
});
