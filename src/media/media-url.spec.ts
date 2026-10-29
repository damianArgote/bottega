import {
  mediaUrlExpiry,
  signedMediaPath,
  verifyMediaSignature,
} from './media-url.js';

const SECRET = 'media-secret-0123456789abcdef0123456789';
const BUSINESS = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';

const parts = (path: string) => {
  const url = new URL(path, 'https://api.example.com');
  return {
    exp: url.searchParams.get('exp') ?? undefined,
    sig: url.searchParams.get('sig') ?? undefined,
  };
};

describe('signed media links', () => {
  const at = new Date('2026-10-29T15:10:00Z');

  it('signs business, message and expiry, and verifies in time', () => {
    const path = signedMediaPath(SECRET, BUSINESS, MESSAGE, at);
    expect(path).toMatch(
      new RegExp(
        `^/inbox/businesses/${BUSINESS}/media/${MESSAGE}\\?exp=\\d+&sig=`,
      ),
    );
    const { exp, sig } = parts(path);

    expect(verifyMediaSignature(SECRET, BUSINESS, MESSAGE, exp, sig, at)).toBe(
      true,
    );
  });

  it('is the same link during a half hour and lives 60 to 90 minutes', () => {
    const early = new Date('2026-10-29T15:00:00Z');
    const late = new Date('2026-10-29T15:29:59Z');
    expect(signedMediaPath(SECRET, BUSINESS, MESSAGE, early)).toBe(
      signedMediaPath(SECRET, BUSINESS, MESSAGE, late),
    );
    expect(mediaUrlExpiry(early) * 1000 - early.getTime()).toBe(90 * 60_000);
    expect(mediaUrlExpiry(late) * 1000 - late.getTime()).toBe(
      60 * 60_000 + 1000,
    );
    expect(
      signedMediaPath(
        SECRET,
        BUSINESS,
        MESSAGE,
        new Date('2026-10-29T15:30:00Z'),
      ),
    ).not.toBe(signedMediaPath(SECRET, BUSINESS, MESSAGE, late));
  });

  it('refuses an expired link, another business or message, a tampered expiry or another secret', () => {
    const { exp, sig } = parts(signedMediaPath(SECRET, BUSINESS, MESSAGE, at));
    const later = new Date(Number(exp) * 1000);

    expect(
      verifyMediaSignature(SECRET, BUSINESS, MESSAGE, exp, sig, later),
    ).toBe(false);
    expect(verifyMediaSignature(SECRET, MESSAGE, MESSAGE, exp, sig, at)).toBe(
      false,
    );
    expect(verifyMediaSignature(SECRET, BUSINESS, BUSINESS, exp, sig, at)).toBe(
      false,
    );
    expect(
      verifyMediaSignature(
        SECRET,
        BUSINESS,
        MESSAGE,
        String(Number(exp) + 60),
        sig,
        at,
      ),
    ).toBe(false);
    expect(
      verifyMediaSignature(`${SECRET}x`, BUSINESS, MESSAGE, exp, sig, at),
    ).toBe(false);
    expect(
      verifyMediaSignature(SECRET, BUSINESS, MESSAGE, undefined, sig, at),
    ).toBe(false);
    expect(
      verifyMediaSignature(SECRET, BUSINESS, MESSAGE, exp, 'short', at),
    ).toBe(false);
    expect(
      verifyMediaSignature(SECRET, BUSINESS, MESSAGE, 'abc', sig, at),
    ).toBe(false);
  });
});
