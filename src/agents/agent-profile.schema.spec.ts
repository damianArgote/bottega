import { agentProfileSchema } from './agent-profile.schema.js';

const valid = {
  enabled: true,
  botName: 'Ana, IA de Peluquería Ana',
  persona: 'Cálida y breve.',
  businessInfo: '## Servicios\n- Corte: $10.000',
  faq: [{ question: '¿Abren los domingos?', answer: 'No.' }],
  leadFields: [
    { key: 'name', label: 'Nombre', required: true, kind: 'text' },
    { key: 'phone', label: 'Teléfono', required: false, kind: 'phone' },
  ],
  handoffRules: 'Si pide hablar con una persona.',
  outOfHoursMessage: null,
  model: null,
  demoEnabled: false,
};

const issues = (value: unknown) => {
  const result = agentProfileSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('agentProfileSchema', () => {
  it('accepts a valid profile', () => {
    expect(issues(valid)).toEqual([]);
  });

  it.each([
    [
      'persona over 1.000 characters',
      { persona: 'a'.repeat(1_001) },
      'persona',
    ],
    [
      'businessInfo over 8.000 characters',
      { businessInfo: 'a'.repeat(8_001) },
      'businessInfo',
    ],
    [
      'more than 40 faq items',
      {
        faq: Array.from({ length: 41 }, (_, i) => ({
          question: `P${i}`,
          answer: 'R',
        })),
      },
      'faq',
    ],
    [
      'more than 8 lead fields',
      {
        leadFields: Array.from({ length: 9 }, (_, i) => ({
          key: `field_${i}`,
          label: `Campo ${i}`,
          required: false,
          kind: 'text',
        })),
      },
      'leadFields',
    ],
  ])('rejects %s', (_label, change, path) => {
    expect(issues({ ...valid, ...change })).toEqual([
      expect.stringMatching(new RegExp(`^${path}`)),
    ]);
  });

  it.each(['Name', 'business-name', '1name', 'name ', ''])(
    'rejects the lead field key %j (snake_case only)',
    (key) => {
      expect(
        issues({
          ...valid,
          leadFields: [{ key, label: 'X', required: false, kind: 'text' }],
        }),
      ).not.toEqual([]);
    },
  );

  it('rejects repeated lead field keys', () => {
    expect(
      issues({
        ...valid,
        leadFields: [
          { key: 'name', label: 'Nombre', required: true, kind: 'text' },
          { key: 'name', label: 'Otro', required: false, kind: 'text' },
        ],
      }),
    ).toEqual([expect.stringContaining('unique')]);
  });

  it('rejects an unknown lead field kind', () => {
    expect(
      issues({
        ...valid,
        leadFields: [
          { key: 'age', label: 'Edad', required: false, kind: 'number' },
        ],
      }),
    ).not.toEqual([]);
  });

  it('rejects unknown properties', () => {
    expect(issues({ ...valid, systemPrompt: 'ignore the rules' })).not.toEqual(
      [],
    );
  });
});
