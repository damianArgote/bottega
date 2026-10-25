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

  describe('openingHours', () => {
    it('is optional and defaults to null', () => {
      expect(agentProfileSchema.parse(valid).openingHours).toBeNull();
    });

    it('accepts ranges by weekday', () => {
      expect(
        issues({
          ...valid,
          openingHours: {
            mon: ['09:00-13:00', '15:00-19:00'],
            sat: ['10:00-14:00'],
          },
        }),
      ).toEqual([]);
    });

    it.each([
      ['a bad format', { mon: ['9-18'] }],
      ['an end before the start', { mon: ['18:00-09:00'] }],
      ['an hour over 23', { mon: ['09:00-24:30'] }],
      ['an unknown day', { lunes: ['09:00-18:00'] }],
      ['more than 4 ranges', { mon: Array(5).fill('09:00-10:00') }],
      ['an empty day', { mon: [] }],
    ])('rejects %s', (_label, openingHours) => {
      expect(issues({ ...valid, openingHours })).not.toEqual([]);
    });
  });
});
