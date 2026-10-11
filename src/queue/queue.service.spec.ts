import { sanitizeError } from './queue.service.js';

describe('sanitizeError', () => {
  it('keeps the error name and code, never the message', () => {
    const error = Object.assign(new Error('token abc and user text'), {
      code: 'ECONNRESET',
    });

    expect(sanitizeError(error)).toBe('Error:ECONNRESET');
  });

  it('handles errors without code and non-error values', () => {
    expect(sanitizeError(new TypeError('x'))).toBe('TypeError');
    expect(sanitizeError({ code: 42 })).toBe('UnknownError:42');
    expect(sanitizeError(undefined)).toBe('UnknownError');
  });

  it('strips unexpected characters and bounds the length', () => {
    const error = Object.assign(new Error(), {
      code: `a b/${'x'.repeat(300)}`,
    });

    const label = sanitizeError(error);

    expect(label).toMatch(/^Error:a_b_x+$/);
    expect(label.length).toBeLessThanOrEqual(120);
  });
});
