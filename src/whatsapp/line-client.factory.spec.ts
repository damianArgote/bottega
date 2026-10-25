import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { CredentialsCipher } from '../lines/credentials-cipher.js';
import type { LineCredentialsService } from '../lines/line-credentials.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  GraphWhatsAppClient,
  LineSendCredentials,
} from './graph-whatsapp.client.js';
import { LineWhatsAppClientFactory } from './line-client.factory.js';

const cipher = new CredentialsCipher(randomBytes(32));
const credentials = cipher as unknown as LineCredentialsService;

function setup(
  line: { phoneNumberId: string; accessTokenEncrypted: string | null } | null,
) {
  const findUnique = vi.fn().mockResolvedValue(line);
  const prisma = { line: { findUnique } } as unknown as PrismaService;
  const sendText = vi
    .fn<
      (
        line: LineSendCredentials,
        to: string,
        body: string,
      ) => ReturnType<GraphWhatsAppClient['sendText']>
    >()
    .mockResolvedValue({ kind: 'sent', waMessageId: 'wamid.out' });
  const graph = { sendText } as unknown as GraphWhatsAppClient;
  return {
    factory: new LineWhatsAppClientFactory(prisma, credentials, graph),
    sendText,
    findUnique,
  };
}

describe('LineWhatsAppClientFactory', () => {
  const logged: string[] = [];

  beforeEach(() => {
    logged.length = 0;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (message: unknown) => {
        logged.push(String(message));
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(logged.join('\n')).not.toContain('line-token-secret');
  });

  it("sends with the line's phone number id and decrypted token", async () => {
    const { factory, sendText, findUnique } = setup({
      phoneNumberId: '111',
      accessTokenEncrypted: cipher.encrypt('line-token-secret'),
    });

    const client = await factory.forLine('line-1');
    const outcome = await client.sendText('5491100001234', 'hola');

    expect(outcome).toEqual({ kind: 'sent', waMessageId: 'wamid.out' });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'line-1' } }),
    );
    expect(sendText).toHaveBeenCalledExactlyOnceWith(
      { phoneNumberId: '111', accessToken: 'line-token-secret' },
      '5491100001234',
      'hola',
    );
  });

  it.each([
    ['a conversation without line', null, null],
    ['a missing line', 'line-1', null],
    [
      'a line without access token',
      'line-1',
      { phoneNumberId: '111', accessTokenEncrypted: null },
    ],
    [
      'a token encrypted with another key',
      'line-1',
      {
        phoneNumberId: '111',
        accessTokenEncrypted: new CredentialsCipher(randomBytes(32)).encrypt(
          'line-token-secret',
        ),
      },
    ],
  ])(
    'rejects sends (not retryable, nothing sent) for %s',
    async (_label, lineId, line) => {
      const { factory, sendText } = setup(line);

      const client = await factory.forLine(lineId);
      const outcome = await client.sendText('5491100001234', 'hola');

      expect(outcome).toMatchObject({
        kind: 'rejected',
        code: 'line_credentials_unavailable',
        httpStatus: null,
        retryable: false,
      });
      expect(sendText).not.toHaveBeenCalled();
    },
  );
});
