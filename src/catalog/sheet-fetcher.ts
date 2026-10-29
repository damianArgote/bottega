import { CSV_MAX_BYTES } from './catalog.schemas.js';
import { isGoogleSheetHost } from './catalog-sheet.js';

/** Downloads a published sheet's CSV text. Throws {@link SheetFetchError}. */
export type SheetFetcher = (url: string) => Promise<string>;

export const SHEET_FETCHER = Symbol('SHEET_FETCHER');

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/**
 * A failed download. `code` is a short static label for logs and the
 * business's last sync error (never the sheet's content).
 */
export class SheetFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SheetFetchError';
  }
}

/**
 * The real fetcher: follows at most 3 redirects, and only to Google's hosts
 * (the published CSV is served from googleusercontent.com); up to 2 MB, 15
 * seconds in all; the answer has to be CSV.
 */
export function httpSheetFetcher(
  fetchImpl: typeof fetch = fetch,
): SheetFetcher {
  return async (url) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let current = url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetchImpl(current, {
          redirect: 'manual',
          signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          const next = location ? new URL(location, current) : null;
          if (
            !next ||
            next.protocol !== 'https:' ||
            !isGoogleSheetHost(next.hostname)
          ) {
            throw new SheetFetchError('sheet_bad_redirect');
          }
          current = next.toString();
          continue;
        }
        if (!response.ok) {
          throw new SheetFetchError(`sheet_http_${response.status}`);
        }
        const type = response.headers.get('content-type') ?? '';
        if (!type.toLowerCase().startsWith('text/csv')) {
          throw new SheetFetchError('sheet_not_csv');
        }
        return await readText(response);
      }
      throw new SheetFetchError('sheet_too_many_redirects');
    } catch (error) {
      if (error instanceof SheetFetchError) {
        throw error;
      }
      throw new SheetFetchError(
        signal.aborted ? 'sheet_timeout' : 'sheet_unreachable',
      );
    }
  };
}

/** The body as UTF-8 text, stopping past {@link CSV_MAX_BYTES}. */
async function readText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > CSV_MAX_BYTES) {
      await reader.cancel();
      throw new SheetFetchError('sheet_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
