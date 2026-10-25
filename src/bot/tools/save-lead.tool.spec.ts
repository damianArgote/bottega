import type { LeadField } from '../../agents/agent-profile.schema.js';
import { saveLeadToolFor } from './save-lead.tool.js';
import type { ToolContext } from './tool.js';

const fields: LeadField[] = [
  { key: 'name', label: 'Nombre', required: true, kind: 'text' },
  { key: 'phone', label: 'Celular', required: false, kind: 'phone' },
  { key: 'email', label: 'Email', required: false, kind: 'email' },
  {
    key: 'visit_date',
    label: 'Fecha de visita',
    required: false,
    kind: 'date',
  },
];

const tool = saveLeadToolFor(fields);
const ctx = {} as ToolContext;

const args = (values: Record<string, string | null> = {}) => ({
  name: null,
  phone: null,
  email: null,
  visit_date: null,
  ...values,
});

const parse = (value: unknown) => tool.schema.safeParse(value);

describe('save_lead generated from leadFields', () => {
  it('builds a strict JSON schema with one nullable string per lead field', () => {
    expect(tool.jsonSchema).toMatchObject({
      type: 'object',
      required: ['name', 'phone', 'email', 'visit_date'],
      additionalProperties: false,
    });
    const properties = (
      tool.jsonSchema as {
        properties: Record<string, { type: string[]; description: string }>;
      }
    ).properties;
    expect(Object.keys(properties)).toEqual([
      'name',
      'phone',
      'email',
      'visit_date',
    ]);
    for (const prop of Object.values(properties)) {
      expect(prop.type).toEqual(['string', 'null']);
    }
    expect(properties.phone?.description).toContain('Celular');
    expect(properties.phone?.description).toContain('máx. 40 caracteres');
    expect(properties.email?.description).toContain('Email');
  });

  it('rejects keys the business did not declare', () => {
    expect(parse(args({ business_name: 'X' })).success).toBe(false);
    expect(parse({ name: 'Ana' }).success).toBe(false);
  });

  it('validates phone and email formats and normalizes them', () => {
    expect(parse(args({ phone: '+54 9 11 2580-8678' })).data).toMatchObject({
      phone: '+5491125808678',
    });
    expect(parse(args({ email: ' Ana@Mail.COM ' })).data).toMatchObject({
      email: 'ana@mail.com',
    });
    for (const phone of ['llamame', '12', '+54 9 11 2580-8678 int 3']) {
      expect(parse(args({ phone })).success).toBe(false);
    }
    for (const email of ['ana', 'ana@', 'ana @mail.com', 'a@b']) {
      expect(parse(args({ email })).success).toBe(false);
    }
  });

  it('keeps text and date as cleaned text, without links', () => {
    expect(
      parse(args({ name: ' Ana\n Pérez ', visit_date: 'el sábado' })).data,
    ).toMatchObject({ name: 'Ana Pérez', visit_date: 'el sábado' });
    expect(parse(args({ name: 'ver https://evil.test' })).success).toBe(false);
    expect(parse(args({ name: 'x'.repeat(201) })).success).toBe(false);
  });

  it('plans only the non-empty values and rejects an empty call', () => {
    const parsed = parse(args({ name: 'Ana', phone: ' ' }));
    expect(parsed.success).toBe(true);

    expect(tool.plan(parsed.data!, ctx)).toEqual({
      ok: true,
      effect: { kind: 'save_lead', values: { name: 'Ana' } },
      output: { saved: ['name'] },
    });
    expect(tool.plan(parse(args()).data!, ctx)).toMatchObject({ ok: false });
  });
});
