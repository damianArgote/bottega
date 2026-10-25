import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RoleGuard } from './role.guard.js';

const contextWith = (businessAccess: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ businessAccess }) }),
  }) as unknown as ExecutionContext;

describe('RoleGuard', () => {
  const OwnerOnly = RoleGuard('OWNER');

  it('lets an OWNER of the route business through', () => {
    expect(
      new OwnerOnly().canActivate(
        contextWith({ businessId: 'b', role: 'OWNER' }),
      ),
    ).toBe(true);
  });

  it('answers 403 to an AGENT', () => {
    expect(() =>
      new OwnerOnly().canActivate(
        contextWith({ businessId: 'b', role: 'AGENT' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('answers 403 when BusinessAccessGuard did not run', () => {
    expect(() => new OwnerOnly().canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
