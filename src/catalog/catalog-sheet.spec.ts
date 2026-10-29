import { canApplyAlone, isPublishedSheetCsvUrl } from './catalog-sheet.js';
import { CSV_MAX_BYTES } from './catalog.schemas.js';
import { httpSheetFetcher, SheetFetchError } from './sheet-fetcher.js';

const PUBLISHED =
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc_123/pub?gid=0&single=true&output=csv';

describe('isPublishedSheetCsvUrl', () => {
  it('accepts a sheet published to the web as CSV', () => {
    expect(isPublishedSheetCsvUrl(PUBLISHED)).toBe(true);
    expect(
      isPublishedSheetCsvUrl(
        'https://docs.google.com/spreadsheets/d/e/X/pub?output=csv',
      ),
    ).toBe(true);
  });

  it.each([
    ['http', PUBLISHED.replace('https:', 'http:')],
    ['another host', PUBLISHED.replace('docs.google.com', 'evil.example.com')],
    [
      'a look-alike host',
      PUBLISHED.replace('docs.google.com', 'docs.google.com.evil.io'),
    ],
    ['HTML output', PUBLISHED.replace('output=csv', 'output=html')],
    ['no output', 'https://docs.google.com/spreadsheets/d/e/X/pub'],
    ['the edit link', 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0'],
    ['a document', 'https://docs.google.com/document/d/e/X/pub?output=csv'],
    ['credentials', PUBLISHED.replace('https://', 'https://user:pw@')],
    ['a port', PUBLISHED.replace('docs.google.com', 'docs.google.com:8443')],
    ['not a URL', 'mi planilla'],
  ])('refuses %s', (_, url) => {
    expect(isPublishedSheetCsvUrl(url)).toBe(false);
  });
});

describe('canApplyAlone', () => {
  const clean = {
    mappingConfirmed: true,
    errors: 0,
    unavailable: 3,
    availableNow: 10,
  };

  it('applies a clean sync that removes up to 30% of the catalog', () => {
    expect(canApplyAlone(clean)).toBe(true);
    expect(canApplyAlone({ ...clean, unavailable: 0, availableNow: 0 })).toBe(
      true,
    );
  });

  it('waits for a person with errors, more than 30% gone or an unconfirmed mapping', () => {
    expect(canApplyAlone({ ...clean, errors: 1 })).toBe(false);
    expect(canApplyAlone({ ...clean, unavailable: 4 })).toBe(false);
    expect(canApplyAlone({ ...clean, mappingConfirmed: false })).toBe(false);
  });
});

describe('httpSheetFetcher', () => {
  const csv = (body: string, type = 'text/csv; charset=utf-8') =>
    new Response(body, { status: 200, headers: { 'content-type': type } });
  const redirect = (location: string) =>
    new Response(null, { status: 307, headers: { location } });
  const fetching = (...responses: Response[]) => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const response of responses) {
      fetchImpl.mockResolvedValueOnce(response);
    }
    return fetchImpl;
  };
  const failsWith = async (fetchImpl: typeof fetch, code: string) => {
    const error = await httpSheetFetcher(fetchImpl)(PUBLISHED).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SheetFetchError);
    expect((error as SheetFetchError).code).toBe(code);
  };

  it("follows Google's redirect to googleusercontent.com, never following automatically", async () => {
    const fetchImpl = fetching(
      redirect('https://doc-0s-sheets.googleusercontent.com/pub/abc'),
      csv('producto,precio\nTorta,100'),
    );

    expect(await httpSheetFetcher(fetchImpl)(PUBLISHED)).toBe(
      'producto,precio\nTorta,100',
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://doc-0s-sheets.googleusercontent.com/pub/abc',
    );
  });

  it('refuses a redirect anywhere else', async () => {
    await failsWith(
      fetching(redirect('http://169.254.169.254/latest/meta-data')),
      'sheet_bad_redirect',
    );
    await failsWith(
      fetching(redirect('https://evil.example.com/x')),
      'sheet_bad_redirect',
    );
  });

  it('refuses errors, HTML and files over 2 MB', async () => {
    await failsWith(
      fetching(new Response('no', { status: 404 })),
      'sheet_http_404',
    );
    await failsWith(
      fetching(csv('<html></html>', 'text/html')),
      'sheet_not_csv',
    );
    await failsWith(
      fetching(csv('x'.repeat(CSV_MAX_BYTES + 1))),
      'sheet_too_large',
    );
  });

  it('reports a network failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('fetch failed'));
    await failsWith(fetchImpl, 'sheet_unreachable');
  });
});
