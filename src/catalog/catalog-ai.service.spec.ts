import { validMapping } from './catalog-ai.service.js';

describe('validMapping', () => {
  const headers = ['Cód', 'Sabor', 'Precio'];
  const blank = {
    externalId: null,
    name: null,
    description: null,
    category: null,
    price: null,
    currency: null,
    available: null,
  };

  it('keeps the fields the model assigned to existing columns', () => {
    expect(
      validMapping(
        { ...blank, externalId: 'Cód', name: 'Sabor', price: 'Precio' },
        headers,
      ),
    ).toEqual({ externalId: 'Cód', name: 'Sabor', price: 'Precio' });
  });

  it('rejects unknown columns, a column used twice, no name or a malformed answer', () => {
    expect(validMapping({ ...blank, name: 'Nombre' }, headers)).toBeNull();
    expect(
      validMapping({ ...blank, name: 'Sabor', price: 'Sabor' }, headers),
    ).toBeNull();
    expect(validMapping({ ...blank, price: 'Precio' }, headers)).toBeNull();
    expect(validMapping('Sabor', headers)).toBeNull();
    expect(validMapping(undefined, headers)).toBeNull();
  });
});
