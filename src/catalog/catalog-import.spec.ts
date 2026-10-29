import {
  type CatalogItemInput,
  defaultMapping,
  deriveExternalId,
  diffCatalog,
  MAX_ROW_ERRORS,
  normalizeRow,
  normalizeSource,
  parseAvailability,
  parsePrice,
  rowHash,
} from './catalog-import.js';
import { csvRecords, parseCsv } from './csv.js';

describe('parsePrice', () => {
  it.each([
    ['$ 1.500,00', '1500.00'],
    ['1500.00', '1500.00'],
    ['1500,5', '1500.50'],
    ['1.500', '1500.00'],
    ['12.000.000', '12000000.00'],
    ['1,500.75', '1500.75'],
    ['ARS 990', '990.00'],
    ['0', '0.00'],
  ])('reads "%s" as %s', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });

  it('takes JSON numbers with two decimals', () => {
    expect(parsePrice(1499.999)).toBe('1500.00');
  });

  it('is null without a price', () => {
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('  ')).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  it.each(['consultar', '1.5.0,0,0', 'abc12', '--5'])(
    'rejects "%s"',
    (input) => {
      expect(() => parsePrice(input)).toThrow('not a number');
    },
  );

  it('rejects negative prices', () => {
    expect(() => parsePrice('-10')).toThrow('negative');
  });
});

describe('parseAvailability', () => {
  it.each([
    ['sí', true],
    ['SI', true],
    ['1', true],
    ['true', true],
    ['Disponible', true],
    ['', true],
    ['no', false],
    ['0', false],
    ['false', false],
    ['AGOTADO', false],
  ])('reads "%s" as %s', (input, expected) => {
    expect(parseAvailability(input)).toBe(expected);
  });

  it('takes JSON booleans and blank as available', () => {
    expect(parseAvailability(false)).toBe(false);
    expect(parseAvailability(null)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(() => parseAvailability('quizás')).toThrow();
  });
});

describe('deriveExternalId', () => {
  it('lowercases, strips accents and collapses spaces', () => {
    expect(deriveExternalId('  Limón   al  Agua ')).toBe('limon al agua');
    expect(deriveExternalId('Ñandú Ácido')).toBe('nandu acido');
  });
});

describe('normalizeRow', () => {
  const mapping = {
    externalId: 'codigo',
    name: 'producto',
    description: 'descripcion',
    category: 'categoria',
    price: 'precio',
    available: 'disponible',
  };

  it('normalizes a row and sends unmapped columns to attributes', () => {
    expect(
      normalizeRow(
        {
          codigo: ' A1 ',
          producto: 'Chocolate amargo',
          descripcion: 'Cacao 70%',
          categoria: 'Helados',
          precio: '$ 1.500,00',
          disponible: 'sí',
          sabores: 'Chocolate',
          vacio: '',
        },
        mapping,
        2,
      ),
    ).toEqual({
      ok: true,
      item: {
        externalId: 'A1',
        name: 'Chocolate amargo',
        description: 'Cacao 70%',
        category: 'Helados',
        price: '1500.00',
        currency: 'ARS',
        available: true,
        attributes: { sabores: 'Chocolate' },
      },
    });
  });

  it('derives the code from the name when the source has none', () => {
    const result = normalizeRow(
      { producto: 'Dulce de Leche' },
      { name: 'producto' },
      2,
    );
    expect(result.ok && result.item.externalId).toBe('dulce de leche');
  });

  it.each([
    [{ producto: '', precio: '10' }, 'Fila 22: falta el nombre.'],
    [
      { producto: 'Torta', precio: 'consultar' },
      'Fila 22: el precio "consultar" no es un número.',
    ],
    [
      { producto: 'Torta', disponible: 'tal vez' },
      'Fila 22: la disponibilidad "tal vez" no se entiende (usá sí o no).',
    ],
  ])('reports %o as "%s"', (record, message) => {
    expect(normalizeRow(record, mapping, 22)).toEqual({
      ok: false,
      error: { row: 22, message },
    });
  });

  it('rejects more than 20 attributes', () => {
    const extra = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`col${i}`, 'x']),
    );
    const result = normalizeRow(
      { producto: 'A', ...extra },
      { name: 'producto' },
      5,
    );
    expect(result.ok).toBe(false);
  });
});

describe('normalizeSource', () => {
  it('keeps the valid rows, reports the invalid ones and repeated codes', () => {
    const records = [
      { codigo: 'A12', producto: 'Uno', precio: '10' },
      { codigo: 'A13', producto: '', precio: '10' },
      { codigo: 'A12', producto: 'Otro', precio: '20' },
      { codigo: 'A14', producto: 'Tres', precio: '30' },
    ];
    const result = normalizeSource(
      records,
      { externalId: 'codigo', name: 'producto', price: 'precio' },
      2,
    );
    expect(result.items.map((i) => i.externalId)).toEqual(['A12', 'A14']);
    expect(result.errors).toEqual([
      { row: 3, message: 'Fila 3: falta el nombre.' },
      {
        row: 4,
        message: 'Fila 4: el código "A12" está repetido en el archivo.',
      },
    ]);
    expect(result.errorCount).toBe(2);
  });

  it(`stores at most ${MAX_ROW_ERRORS} errors but counts all`, () => {
    const records = Array.from({ length: MAX_ROW_ERRORS + 5 }, () => ({
      producto: '',
    }));
    const result = normalizeSource(records, { name: 'producto' }, 2);
    expect(result.errors).toHaveLength(MAX_ROW_ERRORS);
    expect(result.errorCount).toBe(MAX_ROW_ERRORS + 5);
  });
});

describe('defaultMapping', () => {
  it('maps the sample sheet columns, ignoring accents and case', () => {
    expect(
      defaultMapping([
        'Código',
        'Producto',
        'Descripción',
        'Categoría',
        'Precio',
        'Disponible',
        'Sabor',
      ]),
    ).toEqual({
      externalId: 'Código',
      name: 'Producto',
      description: 'Descripción',
      category: 'Categoría',
      price: 'Precio',
      available: 'Disponible',
    });
  });

  it('is null without a name column', () => {
    expect(defaultMapping(['precio', 'sku'])).toBeNull();
  });
});

describe('diffCatalog', () => {
  const item = (externalId: string, price = '10.00'): CatalogItemInput => ({
    externalId,
    name: externalId,
    description: '',
    category: null,
    price,
    currency: 'ARS',
    available: true,
    attributes: {},
  });
  const stored = (i: CatalogItemInput, available = true) => ({
    externalId: i.externalId,
    rowHash: rowHash({ ...i, available }),
    available,
  });

  it('tells created, changed, unchanged and no longer in the source', () => {
    const diff = diffCatalog(
      [stored(item('same')), stored(item('changed')), stored(item('gone'))],
      [item('same'), item('changed', '20.00'), item('new')],
    );
    expect(diff.created.map((i) => i.externalId)).toEqual(['new']);
    expect(diff.updated.map((i) => i.externalId)).toEqual(['changed']);
    expect(diff.unchanged).toBe(1);
    expect(diff.unavailable).toEqual(['gone']);
  });

  it('brings back an unavailable item and does not mark it twice', () => {
    const diff = diffCatalog(
      [stored(item('back'), false), stored(item('off'), false)],
      [item('back')],
    );
    expect(diff.updated.map((i) => i.externalId)).toEqual(['back']);
    expect(diff.unavailable).toEqual([]);
  });

  it('the hash ignores attribute order', () => {
    const a = { ...item('x'), attributes: { b: 1, a: 'z' } };
    const b = { ...item('x'), attributes: { a: 'z', b: 1 } };
    expect(rowHash(a)).toBe(rowHash(b));
  });
});

describe('parseCsv', () => {
  it('reads quotes, escaped quotes, line breaks inside quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",2\n')).toEqual(
      [
        ['a', 'b'],
        ['x, y', 'say "hi"'],
        ['multi\nline', '2'],
      ],
    );
  });

  it('detects the semicolon of Excel in Spanish and strips the BOM', () => {
    expect(parseCsv('﻿producto;precio\nTorta;"1.500,00"\n\n')).toEqual([
      ['producto', 'precio'],
      ['Torta', '1.500,00'],
    ]);
  });

  it('builds records keyed by the header', () => {
    expect(csvRecords(' producto ,precio\nTorta\n')).toEqual({
      headers: ['producto', 'precio'],
      records: [{ producto: 'Torta', precio: '' }],
    });
  });
});
