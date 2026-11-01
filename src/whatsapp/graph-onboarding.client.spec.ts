import { GraphOnboardingClient } from './graph-onboarding.client.js';

const TOKEN = 'templates-token';
const BASE = 'https://graph.facebook.com/v26.0';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const template = (name: string) => ({
  id: `id-${name}`,
  name,
  language: 'es_AR',
  category: 'UTILITY',
  status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Hola' }],
});

describe('GraphOnboardingClient.messageTemplates', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let client: GraphOnboardingClient;

  beforeEach(() => {
    fetchMock.mockReset();
    client = new GraphOnboardingClient(
      { apiVersion: 'v26.0', timeoutMs: 50 },
      fetchMock,
    );
  });

  it('asks for the documented fields and follows paging.next', async () => {
    const next = `${BASE}/waba1/message_templates?after=abc`;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [template('a')], paging: { next } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: [template('b')] }));

    const result = await client.messageTemplates('waba1', TOKEN);

    expect(result).toEqual({
      ok: true,
      data: [template('a'), template('b')],
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${BASE}/waba1/message_templates?fields=id,name,language,category,status,components&limit=100`,
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(next);
    expect(fetchMock.mock.calls[1]![1]?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('fails as a whole when a later page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [template('a')],
          paging: { next: `${BASE}/waba1/message_templates?after=x` },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(400, { error: { code: 190, message: 'expired' } }),
      );

    const result = await client.messageTemplates('waba1', TOKEN);

    expect(result).toMatchObject({ ok: false, error: { code: 190 } });
  });

  it('never sends the token to a next link outside the Graph API', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [],
        paging: { next: 'https://evil.example/steal' },
      }),
    );

    const result = await client.messageTemplates('waba1', TOKEN);

    expect(result).toMatchObject({ ok: false, error: { code: 'bad_paging' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips entries without a name or language', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ id: '1' }, template('a')] }),
    );

    const result = await client.messageTemplates('waba1', TOKEN);

    expect(result).toEqual({ ok: true, data: [template('a')] });
  });
});
