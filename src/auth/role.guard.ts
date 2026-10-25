import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  mixin,
  type Type,
} from '@nestjs/common';
import type { MembershipRole } from '../generated/prisma/client.js';
import type { BusinessAccess } from './business-access.guard.js';

/**
 * Requires a role in the route's business. Use after BusinessAccessGuard:
 * `@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))`.
 */
export function RoleGuard(role: MembershipRole): Type<CanActivate> {
  @Injectable()
  class RoleGuardMixin implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const access = context
        .switchToHttp()
        .getRequest<{ businessAccess?: BusinessAccess }>().businessAccess;
      if (access?.role !== role) {
        throw new ForbiddenException(`Only an ${role} can do this`);
      }
      return true;
    }
  }
  return mixin(RoleGuardMixin);
}
