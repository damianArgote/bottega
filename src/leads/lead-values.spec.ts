import { ZodError } from 'zod';
import {
  cleanLeadValues,
  leadValuesOf,
  legacyColumnsFor,
} from './lead-values.js';

const columns = {
  name: null,
  businessName: null,
  industry: null,
  need: null,
  contactNotes: null,
};

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

  it('leadValuesOf merges the fixed columns under data, data winning', () => {
    expect(
      leadValuesOf({
        ...columns,
        name: 'Ana (column)',
        businessName: 'Consultorio Sur',
        contactNotes: 'por la tarde',
        data: { name: 'Ana', phone: '+5491100000000' },
      }),
    ).toEqual({
      name: 'Ana',
      business_name: 'Consultorio Sur',
      contact_notes: 'por la tarde',
      phone: '+5491100000000',
    });
  });

  it('leadValuesOf ignores non-text data and a missing lead', () => {
    expect(
      leadValuesOf({ ...columns, data: { name: 'Ana', age: 30, x: null } }),
    ).toEqual({ name: 'Ana' });
    expect(leadValuesOf({ ...columns, data: ['not', 'an', 'object'] })).toEqual(
      {},
    );
    expect(leadValuesOf(null)).toEqual({});
  });

  it('legacyColumnsFor maps the old keys only', () => {
    expect(
      legacyColumnsFor({
        name: 'Ana',
        business_name: 'Consultorio Sur',
        industry: 'salud',
        need: 'turnos',
        contact_notes: 'tarde',
        phone: '123',
      }),
    ).toEqual({
      name: 'Ana',
      businessName: 'Consultorio Sur',
      industry: 'salud',
      need: 'turnos',
      contactNotes: 'tarde',
    });
  });
});
