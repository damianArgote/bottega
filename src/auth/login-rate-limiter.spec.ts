import { InMemoryLoginRateLimiter } from './login-rate-limiter.js';

describe('InMemoryLoginRateLimiter', () => {
  let now = 0;
  const limiter = () =>
    new InMemoryLoginRateLimiter({
      max: 5,
      windowMs: 60_000,
      clock: () => now,
    });

  beforeEach(() => {
    now = 1_000_000;
  });

  it('allows 5 attempts per key in a minute and blocks the 6th', () => {
    const l = limiter();
    const results = Array.from({ length: 6 }, () =>
      l.attempt(['ip:1', 'email:a']),
    );

    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('counts each key on its own: another email from the same IP is still limited by the IP', () => {
    const l = limiter();
    for (let i = 0; i < 5; i += 1) {
      l.attempt([`ip:1`, `email:user${i}`]);
    }

    expect(l.attempt(['ip:1', 'email:new'])).toBe(false);
    expect(l.attempt(['ip:2', 'email:new'])).toBe(true);
  });

  it('allows again once the minute passes', () => {
    const l = limiter();
    for (let i = 0; i < 6; i += 1) {
      l.attempt(['ip:1']);
    }

    now += 60_000;

    expect(l.attempt(['ip:1'])).toBe(true);
  });
});
