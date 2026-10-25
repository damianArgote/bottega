import { diffProfiles } from './agent-profile-diff.js';

const base = {
  enabled: true,
  botName: 'Lola',
  persona: 'Simpática.',
  businessInfo: '## Servicios',
  faq: [{ question: '¿Turno?', answer: 'Sí.' }],
  leadFields: [],
  handoffRules: '',
  outOfHoursMessage: null,
  openingHours: null,
  model: null,
  demoEnabled: false,
};

describe('diffProfiles', () => {
  it('lists only the fields that changed, with their text before and after', () => {
    expect(
      diffProfiles(base, { ...base, persona: 'Seria.', enabled: false }),
    ).toEqual([
      { field: 'enabled', before: 'true', after: 'false' },
      { field: 'persona', before: 'Simpática.', after: 'Seria.' },
    ]);
  });

  it('shows lists and objects as indented JSON, and null as null', () => {
    const changes = diffProfiles(base, {
      ...base,
      faq: [],
      openingHours: { mon: ['09:00-18:00'] },
    });

    expect(changes).toEqual([
      {
        field: 'faq',
        before:
          '[\n  {\n    "question": "¿Turno?",\n    "answer": "Sí."\n  }\n]',
        after: '[]',
      },
      {
        field: 'openingHours',
        before: null,
        after: '{\n  "mon": [\n    "09:00-18:00"\n  ]\n}',
      },
    ]);
  });

  it('the first version lists every field that has a value', () => {
    const changes = diffProfiles(null, base);

    expect(changes.map((c) => c.field)).toEqual([
      'enabled',
      'botName',
      'persona',
      'businessInfo',
      'faq',
      'leadFields',
      'handoffRules',
      'demoEnabled',
    ]);
    expect(changes.every((c) => c.before === null)).toBe(true);
  });

  it('no change gives an empty list', () => {
    expect(diffProfiles(base, { ...base })).toEqual([]);
  });
});
