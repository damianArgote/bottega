import {
  SessionTokens,
  hashRefreshToken,
  newRefreshToken,
} from './session-tokens.js';

const SECRET = 'unit-jwt-secret-0123456789abcdef0123456789';

describe('SessionTokens', () => {
  it('signs a 15-minute HS256 JWT for the user and verifies it', async () => {
    const tokens = new SessionTokens(SECRET);
    const jwt = await tokens.sign('user-1', new Date('2026-10-25T10:00:00Z'));

    const [header, payload] = jwt
      .split('.')
      .slice(0, 2)
      .map(
        (part) =>
          JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
            string,
            unknown
          >,
      );
    expect(header).toMatchObject({ alg: 'HS256' });
    expect(payload).toMatchObject({ sub: 'user-1' });
    expect((payload!.exp as number) - (payload!.iat as number)).toBe(15 * 60);
    expect(await tokens.verify(jwt, new Date('2026-10-25T10:14:00Z'))).toBe(
      'user-1',
    );
  });

  it('rejects an expired, tampered or foreign token', async () => {
    const tokens = new SessionTokens(SECRET);
    const jwt = await tokens.sign('user-1', new Date('2026-10-25T10:00:00Z'));
    const at = new Date('2026-10-25T10:05:00Z');

    expect(
      await tokens.verify(jwt, new Date('2026-10-25T10:16:00Z')),
    ).toBeNull();
    expect(await tokens.verify(`${jwt.slice(0, -2)}xx`, at)).toBeNull();
    expect(
      await new SessionTokens(`${SECRET}-other`).verify(jwt, at),
    ).toBeNull();
    expect(await tokens.verify('not-a-jwt', at)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('are random, URL-safe and stored only as a hash', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).not.toContain(a);
  });
});
