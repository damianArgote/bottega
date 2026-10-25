import { PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id and never stores the password', async () => {
    const hash = await hasher.hash('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('verifies the right password only', async () => {
    const hash = await hasher.hash('correct horse battery');

    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'wrong password!')).toBe(false);
  });

  it('treats a malformed hash as a failed verification', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
  });
});
