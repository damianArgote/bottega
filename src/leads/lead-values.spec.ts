import { ZodError } from 'zod';
import { cleanLeadValues, leadValuesOf } from './lead-values.js';

describe('lead values', () => {
  it('cleanLeadValues keeps only non-empty, trimmed values', () => {
    expect(
      cleanLeadValues({ name: ' Ana ', business_name: '', need: '   ' }),
    ).toEqual({ name: 'Ana' });
  });

  it('cleanLeadValues rejects keys that are not snake_case and long values', () => {
    expect(() => cleanLeadValues({ businessName: 'X' })).toThrow(ZodError);
    expect(() => cleanLeadValues({ name: 'x'.repeat(501) })).toThrow(ZodError);
  });

  it('leadValuesOf reads Lead.data', () => {
    expect(
      leadValuesOf({
        data: { name: 'Ana', business_name: 'Consultorio Sur', phone: '+549' },
      }),
    ).toEqual({ name: 'Ana', business_name: 'Consultorio Sur', phone: '+549' });
  });

  it('leadValuesOf ignores non-text data and a missing lead', () => {
    expect(leadValuesOf({ data: { name: 'Ana', age: 30, x: null } })).toEqual({
      name: 'Ana',
    });
    expect(leadValuesOf({ data: ['not', 'an', 'object'] })).toEqual({});
    expect(leadValuesOf(null)).toEqual({});
  });
});
