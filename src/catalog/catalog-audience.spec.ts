import { visibleCatalogIds, type AudienceCatalog } from './catalog-audience.js';

const all = (id: string): AudienceCatalog => ({
  id,
  audience: 'ALL',
  replacesAll: false,
  tagIds: [],
});
const tagged = (
  id: string,
  tagIds: string[],
  replacesAll = false,
): AudienceCatalog => ({ id, audience: 'TAGGED', replacesAll, tagIds });

describe('visibleCatalogIds', () => {
  it('a contact sees every ALL catalog', () => {
    expect(visibleCatalogIds([all('a'), all('b')], new Set())).toEqual([
      'a',
      'b',
    ]);
  });

  it('a TAGGED catalog is hidden from a contact without any of its tags', () => {
    expect(
      visibleCatalogIds([all('a'), tagged('w', ['mayorista'])], new Set()),
    ).toEqual(['a']);
    expect(
      visibleCatalogIds(
        [all('a'), tagged('w', ['mayorista'])],
        new Set(['vip']),
      ),
    ).toEqual(['a']);
  });

  it('a TAGGED catalog is seen with any one of its tags', () => {
    const catalogs = [all('a'), tagged('w', ['mayorista', 'revendedor'])];
    expect(visibleCatalogIds(catalogs, new Set(['revendedor']))).toEqual([
      'a',
      'w',
    ]);
    expect(
      visibleCatalogIds(catalogs, new Set(['mayorista', 'revendedor', 'vip'])),
    ).toEqual(['a', 'w']);
  });

  it('a seen replaces_all catalog hides the ALL ones, not other TAGGED ones', () => {
    const catalogs = [
      all('a'),
      tagged('w', ['mayorista'], true),
      tagged('v', ['vip']),
    ];
    expect(visibleCatalogIds(catalogs, new Set(['mayorista', 'vip']))).toEqual([
      'w',
      'v',
    ]);
    // Not seen: it replaces nothing.
    expect(visibleCatalogIds(catalogs, new Set(['vip']))).toEqual(['a', 'v']);
  });

  it('a TAGGED catalog without tags is never seen', () => {
    expect(visibleCatalogIds([tagged('w', [], true)], new Set(['x']))).toEqual(
      [],
    );
  });
});
