import { keepsAnActiveOwner } from './business-owners.js';

const owner = (userId: string, active = true) =>
  ({ userId, role: 'OWNER', active }) as const;
const agent = (userId: string) =>
  ({ userId, role: 'AGENT', active: true }) as const;

describe('keepsAnActiveOwner', () => {
  it('rejects demoting or deactivating the only active OWNER', () => {
    const members = [owner('o'), agent('a'), owner('x', false)];

    expect(keepsAnActiveOwner(members, { userId: 'o', role: 'AGENT' })).toBe(
      false,
    );
    expect(keepsAnActiveOwner(members, { userId: 'o', active: false })).toBe(
      false,
    );
  });

  it('allows it while another active OWNER remains', () => {
    const members = [owner('o'), owner('p'), agent('a')];

    expect(keepsAnActiveOwner(members, { userId: 'o', role: 'AGENT' })).toBe(
      true,
    );
    expect(keepsAnActiveOwner(members, { userId: 'o', active: false })).toBe(
      true,
    );
  });

  it('allows any change that leaves the owners as they are or adds one', () => {
    const members = [owner('o'), agent('a'), owner('x', false)];

    expect(keepsAnActiveOwner(members, { userId: 'a', active: false })).toBe(
      true,
    );
    expect(keepsAnActiveOwner(members, { userId: 'o', role: 'OWNER' })).toBe(
      true,
    );
    expect(
      keepsAnActiveOwner([agent('a')], { userId: 'a', role: 'OWNER' }),
    ).toBe(true);
    expect(
      keepsAnActiveOwner([owner('x', false)], { userId: 'x', active: true }),
    ).toBe(true);
  });
});
