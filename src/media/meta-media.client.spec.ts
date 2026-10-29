import {
  isMetaMediaHost,
  MediaFetchError,
  MetaMediaClient,
} from './meta-media.client.js';

const TOKEN = 'line-token-never-leaks';
const META_URL =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';

const respond = (...responses: Response[]) => {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }
  return fetchImpl;
};
const client = (fetchImpl: typeof fetch) =>
  new MetaMediaClient({ apiVersion: 'v26.0', timeoutMs: 1000 }, fetchImpl);
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MediaFetchError);
  const { code, retryable } = error as MediaFetchError;
  return { code, retryable };
};

describe('MetaMediaClient', () => {
  it('reads the temporary URL, type and size of an attachment', async () => {
    const fetchImpl = respond(
      Response.json({
        url: META_URL,
        mime_type: 'audio/ogg',
        file_size: 4321,
        id: '1',
      }),
    );

    expect(await client(fetchImpl).info(TOKEN, '123')).toEqual({
      url: META_URL,
      mimeType: 'audio/ogg',
      fileSize: 4321,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v26.0/123');
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init?.redirect).toBe('manual');
  });

  it('classifies Meta errors: gone, retry later, give up', async () => {
    expect(
      await failure(
        client(respond(new Response('', { status: 404 }))).info(TOKEN, '1'),
      ),
    ).toEqual({ code: 'media_gone', retryable: false });
    expect(
      await failure(
        client(respond(new Response('', { status: 503 }))).info(TOKEN, '1'),
      ),
    ).toEqual({ code: 'media_unavailable', retryable: true });
    expect(
      await failure(
        client(respond(new Response('', { status: 401 }))).info(TOKEN, '1'),
      ),
    ).toEqual({ code: 'media_unavailable', retryable: false });
    const offline = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('fetch failed'));
    expect(await failure(client(offline).info(TOKEN, '1'))).toEqual({
      code: 'media_unavailable',
      retryable: true,
    });
  });

  it('downloads only from Meta hosts over https, without following redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const url of [
      'https://evil.example.com/file',
      'http://lookaside.fbsbx.com/file',
      'https://lookaside.fbsbx.com.evil.io/file',
      'not a url',
    ]) {
      expect(
        await failure(client(fetchImpl).download(TOKEN, url, 100)),
      ).toEqual({ code: 'media_bad_url', retryable: false });
    }
    // The token never left.
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirect = respond(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com' },
      }),
    );
    expect(
      await failure(client(redirect).download(TOKEN, META_URL, 100)),
    ).toEqual({ code: 'media_bad_url', retryable: false });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('downloads the file up to the limit', async () => {
    const ok = respond(new Response(Buffer.from('audio-bytes')));
    expect((await client(ok).download(TOKEN, META_URL, 100)).toString()).toBe(
      'audio-bytes',
    );

    const big = respond(new Response(Buffer.alloc(200)));
    expect(await failure(client(big).download(TOKEN, META_URL, 100))).toEqual({
      code: 'too_large',
      retryable: false,
    });
  });

  it('passes a range on to Meta for streaming', async () => {
    const fetchImpl = respond(new Response('part', { status: 206 }));

    const response = await client(fetchImpl).open(TOKEN, META_URL, 'bytes=0-3');

    expect(response.status).toBe(206);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Range: 'bytes=0-3',
    });
  });

  it('knows Meta media hosts', () => {
    expect(isMetaMediaHost('lookaside.fbsbx.com')).toBe(true);
    expect(isMetaMediaHost('scontent.xx.fbsbx.com')).toBe(true);
    expect(isMetaMediaHost('fbsbx.com.evil.io')).toBe(false);
    expect(isMetaMediaHost('evilfbsbx.com')).toBe(false);
  });
});

describe('MetaMediaClient timeouts', () => {
  /** A file whose body arrives 60 ms after the headers. */
  const slowBody = (signal: AbortSignal | null | undefined) =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (signal?.aborted) {
            controller.error(new Error('aborted'));
            return;
          }
          controller.enqueue(new TextEncoder().encode('slow'));
          controller.close();
        },
      }),
    );
  const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
    Promise.resolve(slowBody(init?.signal)),
  );
  const slow = () =>
    new MetaMediaClient({ apiVersion: 'v26.0', timeoutMs: 20 }, fetchImpl);

  it('a stream for the inbox is not cut once the headers arrived', async () => {
    const response = await slow().open(TOKEN, META_URL);
    expect(await response.text()).toBe('slow');
  });

  it("the bot's download is bounded as a whole", async () => {
    const error = await slow()
      .download(TOKEN, META_URL, 100)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaFetchError);
  });
});
