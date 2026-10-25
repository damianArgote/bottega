import { metaErrorKind } from './meta-errors.js';

describe('metaErrorKind', () => {
  it('maps the documented codes in one place', () => {
    expect(metaErrorKind(131047)).toBe('window_closed');
    expect(metaErrorKind(131026)).toBe('undeliverable');
    for (const code of [130429, 131056, 131048, 131049, 80007, 4]) {
      expect(metaErrorKind(code)).toBe('rate_limited');
    }
    expect(metaErrorKind(190)).toBe('other');
    expect(metaErrorKind('line_credentials_unavailable')).toBe('other');
  });
});
