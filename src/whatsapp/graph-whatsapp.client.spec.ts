import { Logger } from '@nestjs/common';
import { GraphWhatsAppClient } from './graph-whatsapp.client.js';

const TOKEN = 'graph-access-token-must-never-leak';
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
      {
        accessToken: TOKEN,
        phoneNumberId: '123',
        apiVersion: 'v26.0',
        timeoutMs: 50,
      },
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

    const outcome = await client.sendText(TO, BODY);

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

    expect(await client.sendText(TO, BODY)).toMatchObject({
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

    expect(await client.sendText(TO, BODY)).toEqual({
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

    expect(await client.sendText(TO, BODY)).toMatchObject({
      kind: 'rejected',
      code: 190,
      retryable: false,
    });
  });

  it('classifies HTTP 429 as retryable rejection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: 130429, message: 'throughput' } }),
    );

    expect(await client.sendText(TO, BODY)).toMatchObject({
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

    expect(await client.sendText(TO, BODY)).toMatchObject({
      kind: 'rejected',
      retryable: true,
    });
  });

  it('classifies 4xx without error body using the http status', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));

    expect(await client.sendText(TO, BODY)).toEqual({
      kind: 'rejected',
      code: 404,
      httpStatus: 404,
      message: 'http 404',
      retryable: false,
    });
  });

  it('classifies 500 as uncertain', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 1 } }));

    expect(await client.sendText(TO, BODY)).toEqual({
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

    expect(await client.sendText(TO, BODY)).toEqual({
      kind: 'uncertain',
      reason: 'request timed out or was aborted',
    });
  });

  it('classifies ECONNREFUSED as retryable rejection', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));

    expect(await client.sendText(TO, BODY)).toEqual({
      kind: 'rejected',
      code: 'ECONNREFUSED',
      httpStatus: null,
      message: 'connection could not be established',
      retryable: true,
    });
  });

  it('classifies a connection reset after sending as uncertain', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNRESET'));

    expect(await client.sendText(TO, BODY)).toEqual({
      kind: 'uncertain',
      reason: 'network error (ECONNRESET)',
    });
  });

  it('never exposes the token in outcomes', async () => {
    fetchMock.mockRejectedValue(new Error(`boom ${TOKEN}`));

    const outcome = await client.sendText(TO, BODY);

    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });
});
