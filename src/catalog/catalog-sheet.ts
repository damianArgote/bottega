/**
 * Google Sheets "Publish to the web" as CSV: the only URLs a business may
 * set. Anything else (other hosts, private sheets, HTML output) is refused,
 * so the server never fetches an arbitrary URL.
 */
export function isPublishedSheetCsvUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'docs.google.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith('/spreadsheets/') &&
    url.pathname.endsWith('/pub') &&
    url.searchParams.get('output') === 'csv'
  );
}

/** Hosts a published sheet may redirect to while it is downloaded. */
export function isGoogleSheetHost(hostname: string): boolean {
  return (
    hostname === 'docs.google.com' ||
    hostname.endsWith('.googleusercontent.com')
  );
}

/** A sync's preview is applied by itself only below this share. */
export const MAX_UNAVAILABLE_SHARE = 0.3;

/**
 * Whether a sheet sync may apply without a person: a confirmed mapping, no
 * row errors, and at most 30% of the available items becoming unavailable.
 */
export function canApplyAlone(input: {
  mappingConfirmed: boolean;
  errors: number;
  unavailable: number;
  availableNow: number;
}): boolean {
  return (
    input.mappingConfirmed &&
    input.errors === 0 &&
    input.unavailable <= input.availableNow * MAX_UNAVAILABLE_SHARE
  );
}
