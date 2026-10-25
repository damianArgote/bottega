import { Logger } from '@nestjs/common';
import { GraphWhatsAppClient } from './graph-whatsapp.client.js';

const TOKEN = 'graph-access-token-must-never-leak';
const LINE = { phoneNumberId: '123', accessToken: TOKEN };
const TO = '5491112345678';
const BODY = 'secret message body';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function networkError(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

describe('GraphWhatsAppClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logged: string[] = [];
  let client: GraphWhatsAppClient;

  beforeEach(() => {
    fetchMock.mockReset();
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logged.push(String(message));
        },
      );
    }
    client = new GraphWhatsAppClient(
      { apiVersion: 'v26.0', timeoutMs: 50 },
      fetchMock,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const output = logged.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(BODY);
    expect(output).not.toContain(TO);
  });

  it('sends the documented request and returns sent with the wamid', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: 'wamid.out' }] }),
    );

    const outcome = await client.sendText(LINE, TO, BODY);

    expect(outcome).toEqual({ kind: 'sent', waMessageId: 'wamid.out' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v26.0/123/messages');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'text',
      text: { preview_url: false, body: BODY },
    });
  });

  it('classifies a 2xx without message id as uncertain', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    expect(await client.sendText(LINE, TO, BODY)).toMatchObject({
      kind: 'uncertain',
    });
  });

  it('classifies 400 with code 131047 as non-retryable rejection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 131047,
          message: 'Re-engagement message',
          type: 'OAuthException',
          fbtrace_id: 'trace',
        },
      }),
    );

    expect(await client.sendText(LINE, TO, BODY)).toEqual({
      kind: 'rejected',
      code: 131047,
      httpStatus: 400,
      message: 'Re-engagement message',
      retryable: false,
    });
  });

  it('classifies an expired token (190) as non-retryable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 190, message: 'expired' } }),
    );

    expect(await client.sendText(LINE, TO, BODY)).toMatchObject({
      kind: 'rejected',
      code: 190,
      retryable: false,
    });
  });

  it('classifies HTTP 429 as retryable rejection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: 130429, message: 'throughput' } }),
    );

    expect(await client.sendText(LINE, TO, BODY)).toMatchObject({
      kind: 'rejected',
      code: 130429,
      httpStatus: 429,
      retryable: true,
    });
  });

  it('classifies 400 with code 131056 as retryable rejection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: 131056, message: 'pair rate' } }),
    );

    expect(await client.sendText(LINE, TO, BODY)).toMatchObject({
      kind: 'rejected',
      retryable: true,
    });
  });

  it.each([131048, 131049])(
    'classifies %s (rate limit) as retryable rejection',
    async (code) => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, { error: { code, message: 'limit' } }),
      );

      expect(await client.sendText(LINE, TO, BODY)).toMatchObject({
        kind: 'rejected',
        code,
        retryable: true,
      });
    },
  );

  describe('markRead', () => {
    it('sends the documented read receipt and returns true', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

      expect(await client.markRead(LINE, 'wamid.in.1')).toBe(true);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://graph.facebook.com/v26.0/123/messages');
      expect(JSON.parse(init?.body as string)).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.in.1',
      });
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });

    it('returns false instead of throwing on an error or a network failure', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { error: { code: 100, message: 'bad' } }),
      );
      fetchMock.mockRejectedValueOnce(networkError('ECONNRESET'));

      expect(await client.markRead(LINE, 'wamid.in.1')).toBe(false);
      expect(await client.markRead(LINE, 'wamid.in.1')).toBe(false);
    });
  });

  it('classifies 4xx without error body using the http status', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));

    expect(await client.sendText(LINE, TO, BODY)).toEqual({
      kind: 'rejected',
      code: 404,
      httpStatus: 404,
      message: 'http 404',
      retryable: false,
    });
  });

  it('classifies 500 as uncertain', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 1 } }));

    expect(await client.sendText(LINE, TO, BODY)).toEqual({
      kind: 'uncertain',
      reason: 'http 500',
    });
  });

  it('classifies a timeout as uncertain', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          );
        }),
    );

    expect(await client.sendText(LINE, TO, BODY)).toEqual({
      kind: 'uncertain',
      reason: 'request timed out or was aborted',
    });
  });

  it('classifies ECONNREFUSED as retryable rejection', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));

    expect(await client.sendText(LINE, TO, BODY)).toEqual({
      kind: 'rejected',
      code: 'ECONNREFUSED',
      httpStatus: null,
      message: 'connection could not be established',
      retryable: true,
    });
  });

  it('classifies a connection reset after sending as uncertain', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNRESET'));

    expect(await client.sendText(LINE, TO, BODY)).toEqual({
      kind: 'uncertain',
      reason: 'network error (ECONNRESET)',
    });
  });

  it('never exposes the token in outcomes', async () => {
    fetchMock.mockRejectedValue(new Error(`boom ${TOKEN}`));

    const outcome = await client.sendText(LINE, TO, BODY);

    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it('uses the phone number id and token of each call', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { messages: [{ id: 'wamid.out' }] })),
    );

    await client.sendText(
      { phoneNumberId: '111', accessToken: 'token-a' },
      TO,
      BODY,
    );
    await client.sendText(
      { phoneNumberId: '222', accessToken: 'token-b' },
      TO,
      BODY,
    );

    const calls = fetchMock.mock.calls.map(([url, init]) => [
      url,
      (init?.headers as Record<string, string>)['Authorization'],
    ]);
    expect(calls).toEqual([
      ['https://graph.facebook.com/v26.0/111/messages', 'Bearer token-a'],
      ['https://graph.facebook.com/v26.0/222/messages', 'Bearer token-b'],
    ]);
  });

  describe('subscribeApp', () => {
    it('subscribes the app to the WhatsApp account with the line token', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

      const result = await client.subscribeApp('5550001', TOKEN);

      expect(result).toEqual({ subscribed: true });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'https://graph.facebook.com/v26.0/5550001/subscribed_apps',
      );
      expect(init).toMatchObject({
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
    });

    it('reports a Meta rejection without throwing', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          error: { code: 100, message: 'Unsupported post request' },
        }),
      );

      const result = await client.subscribeApp('5550001', TOKEN);

      expect(result).toEqual({
        subscribed: false,
        code: 100,
        message: 'Unsupported post request',
      });
    });

    it('reports a 2xx without success as not subscribed', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { success: false }));

      expect(await client.subscribeApp('5550001', TOKEN)).toMatchObject({
        subscribed: false,
      });
    });

    it('reports a network failure without throwing', async () => {
      fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));

      expect(await client.subscribeApp('5550001', TOKEN)).toMatchObject({
        subscribed: false,
        code: 'network_error',
      });
    });
  });
});
