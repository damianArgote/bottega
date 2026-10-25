import { csvCell, leadsCsv } from './leads-csv.js';

describe('csvCell', () => {
  it('quotes every cell and doubles its quotes', () => {
    expect(csvCell('Kubbo')).toBe('"Kubbo"');
    expect(csvCell('dijo "hola", chau')).toBe('"dijo ""hola"", chau"');
  });

  it.each(['=SUM(A1)', '+54 9 11', '-1', '@cmd', '\tx', '\rx'])(
    'neutralizes a formula: %j starts with a quote mark',
    (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    },
  );

  it('neutralizes a formula that also has quotes', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
});

describe('leadsCsv', () => {
  const fields = [
    { key: 'name', label: 'Nombre', required: true, kind: 'text' as const },
    { key: 'email', label: 'Email', required: false, kind: 'email' as const },
  ];

  it('has the lead fields, then date, profile name and phone, one row per lead', () => {
    const csv = leadsCsv(
      fields,
      [
        {
          createdAt: new Date('2026-10-25T03:30:00Z'),
          profileName: 'Alberto',
          waId: '5491125808678',
          data: { name: '=SUM(A1)', other: 'ignored', email: 7 },
        },
        {
          createdAt: new Date('2026-10-25T13:05:00Z'),
          profileName: null,
          waId: '5491100000000',
          data: {},
        },
      ],
      'America/Argentina/Buenos_Aires',
    );

    expect(csv).toBe(
      '\uFEFF' +
        '"Nombre","Email","Fecha","Nombre de perfil","Teléfono"\r\n' +
        `"'=SUM(A1)","7","2026-10-25 00:30","Alberto","5491125808678"\r\n` +
        '"","","2026-10-25 10:05","","5491100000000"\r\n',
    );
  });

  it('with no leads it is only the header', () => {
    expect(leadsCsv([], [], 'UTC')).toBe(
      '\uFEFF"Fecha","Nombre de perfil","Teléfono"\r\n',
    );
  });
});
