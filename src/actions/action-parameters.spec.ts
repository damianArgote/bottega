import {
  actionArgumentsSchema,
  actionJsonSchema,
  actionParametersSchema,
} from './action-parameters.js';

const booking = actionParametersSchema.parse({
  properties: {
    dia: { type: 'string', description: 'Día pedido', maxLength: 20 },
    personas: { type: 'integer', minimum: 1, maximum: 12 },
    sector: { type: 'string', enum: ['salon', 'terraza'] },
    vegano: { type: 'boolean' },
    sena: { type: 'number' },
  },
  required: ['dia', 'personas'],
});

describe('action parameters', () => {
  it('accepts the JSON Schema subset and rejects the rest', () => {
    const ok = (value: unknown) =>
      actionParametersSchema.safeParse(value).success;

    expect(ok({ properties: {} })).toBe(true);
    // A string needs a maximum length (or an enum).
    expect(ok({ properties: { a: { type: 'string' } } })).toBe(false);
    expect(
      ok({ properties: { a: { type: 'string', maxLength: 501 } } }),
    ).toBe(false);
    expect(ok({ properties: { a: { type: 'array' } } })).toBe(false);
    expect(ok({ properties: { a: { type: 'object' } } })).toBe(false);
    expect(
      ok({ properties: { a: { type: 'string', maxLength: 5, pattern: 'x' } } }),
    ).toBe(false);
    expect(ok({ properties: { Dia: { type: 'boolean' } } })).toBe(false);
    expect(
      ok({ properties: { a: { type: 'boolean' } }, required: ['b'] }),
    ).toBe(false);
    expect(
      ok({ properties: { a: { type: 'integer', minimum: 5, maximum: 1 } } }),
    ).toBe(false);
    const nine = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`p${i}`, { type: 'boolean' }]),
    );
    expect(ok({ properties: nine })).toBe(false);
  });

  it('gives the model a strict schema, with the optional parameters nullable', () => {
    expect(actionJsonSchema(booking)).toEqual({
      type: 'object',
      properties: {
        dia: { type: 'string', description: 'Día pedido', maxLength: 20 },
        personas: { type: 'integer', minimum: 1, maximum: 12 },
        sector: { type: ['string', 'null'], enum: ['salon', 'terraza', null] },
        vegano: { type: ['boolean', 'null'] },
        sena: { type: ['number', 'null'] },
      },
      required: ['dia', 'personas', 'sector', 'vegano', 'sena'],
      additionalProperties: false,
    });
  });

  it('validates arguments: types, bounds, enums, length, unknown keys; nulls are left out', () => {
    const args = actionArgumentsSchema(booking);

    expect(
      args.parse({
        dia: '  jueves\n10 hs ',
        personas: 4,
        sector: null,
        vegano: true,
        sena: null,
      }),
    ).toEqual({ dia: 'jueves 10 hs', personas: 4, vegano: true });
    for (const bad of [
      { personas: 4 },
      { dia: 'jueves', personas: 4.5 },
      { dia: 'jueves', personas: 13 },
      { dia: 'jueves', personas: 2, sector: 'patio' },
      { dia: 'x'.repeat(21), personas: 2 },
      { dia: '   ', personas: 2 },
      { dia: 'jueves', personas: 2, extra: 1 },
      { dia: 'jueves', personas: '2' },
    ]) {
      expect(args.safeParse(bad).success).toBe(false);
    }
  });
});
