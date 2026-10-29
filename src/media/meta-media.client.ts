/** What Meta says about an attachment (`GET /{media_id}`). */
export interface MediaInfo {
  /** Temporary download URL (expires in minutes): never stored. */
  url: string;
  mimeType: string | null;
  fileSize: number | null;
}

/**
 * A failed attachment fetch. `code` is static: `media_gone` (Meta deleted it
 * or the id is unknown), `media_unavailable` (network, 429, 5xx, token),
 * `media_bad_url` (a download URL outside Meta) or `too_large`.
 */
export class MediaFetchError extends Error {
  constructor(
    readonly code:
      'media_gone' | 'media_unavailable' | 'media_bad_url' | 'too_large',
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'MediaFetchError';
  }
}

/**
 * Hosts Meta serves attachment files from. The line's token is sent only
 * there: a download URL anywhere else is refused before any request.
 */
export function isMetaMediaHost(hostname: string): boolean {
  return hostname === 'lookaside.fbsbx.com' || hostname.endsWith('.fbsbx.com');
}

export interface MetaMediaClientOptions {
  /** e.g. `v26.0` */
  apiVersion: string;
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * WhatsApp Cloud API attachments, with a line's token on every call. Never
 * logs the token or the temporary URL.
 */
export class MetaMediaClient {
  private readonly baseUrl: string;

  constructor(
    private readonly options: MetaMediaClientOptions,
    private readonly fetchImpl: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    this.baseUrl = `${options.baseUrl ?? 'https://graph.facebook.com'}/${options.apiVersion}`;
  }

  /** `GET /{media_id}`: its temporary URL, type and size. */
  async info(accessToken: string, mediaId: string): Promise<MediaInfo> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/${encodeURIComponent(mediaId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      throw new MediaFetchError('media_unavailable', true);
    }
    if (!response.ok) {
      throw statusError(response.status);
    }
    let body: { url?: unknown; mime_type?: unknown; file_size?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new MediaFetchError('media_unavailable', true);
    }
    if (typeof body.url !== 'string') {
      throw new MediaFetchError('media_unavailable', true);
    }
    return {
      url: body.url,
      mimeType: typeof body.mime_type === 'string' ? body.mime_type : null,
      fileSize:
        typeof body.file_size === 'number'
          ? body.file_size
          : typeof body.file_size === 'string' && /^\d+$/.test(body.file_size)
            ? Number(body.file_size)
            : null,
    };
  }

  /**
   * The file's response (200, or 206 for a `range`), for streaming. Only a
   * Meta https host receives the token; redirects are not followed.
   */
  async open(
    accessToken: string,
    url: string,
    range?: string,
  ): Promise<Response> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new MediaFetchError('media_bad_url', false);
    }
    if (target.protocol !== 'https:' || !isMetaMediaHost(target.hostname)) {
      throw new MediaFetchError('media_bad_url', false);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(range ? { Range: range } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new MediaFetchError('media_unavailable', true);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new MediaFetchError('media_bad_url', false);
    }
    if (!response.ok) {
      throw statusError(response.status);
    }
    return response;
  }

  /** The whole file, stopping past `maxBytes`. */
  async download(
    accessToken: string,
    url: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const response = await this.open(accessToken, url);
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new MediaFetchError('too_large', false);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof MediaFetchError) {
        throw error;
      }
      throw new MediaFetchError('media_unavailable', true);
    }
    return Buffer.concat(chunks);
  }
}

/** 404/400/410: gone; 429 and 5xx: retry later; anything else: give up. */
function statusError(status: number): MediaFetchError {
  if (status === 404 || status === 400 || status === 410) {
    return new MediaFetchError('media_gone', false);
  }
  return new MediaFetchError(
    'media_unavailable',
    status === 429 || status >= 500,
  );
}
