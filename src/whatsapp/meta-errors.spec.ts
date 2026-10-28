import { metaErrorKind, onboardingErrorMessage } from './meta-errors.js';

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

describe('onboardingErrorMessage', () => {
  it.each([
    [190, null, 'El token no es válido o venció'],
    [200, null, 'El token no tiene permiso sobre esta cuenta'],
    [10, null, 'El token no tiene permiso sobre esta cuenta'],
    [100, null, 'Algún ID está mal o no corresponde a esta cuenta'],
    [133005, null, 'El PIN no coincide'],
    [100, 2388023, 'El PIN no coincide'],
    [133006, null, 'El número todavía no está verificado'],
    [133016, null, 'Demasiados intentos de registro'],
    ['network_error', null, 'No pudimos conectar con Meta'],
  ] as const)('explains %s (subcode %s)', (code, subcode, text) => {
    expect(onboardingErrorMessage({ code, subcode })).toContain(text);
  });

  it('falls back to a generic text for unknown codes', () => {
    expect(onboardingErrorMessage({ code: 999999, subcode: null })).toBe(
      'Meta rechazó el pedido (código 999999).',
    );
  });

  it('leaves the send error kinds as they were', () => {
    expect(metaErrorKind(190)).toBe('other');
    expect(metaErrorKind(131047)).toBe('window_closed');
  });
});
