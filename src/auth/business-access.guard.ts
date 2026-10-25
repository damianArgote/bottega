import {
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { MembershipRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SessionUser } from './auth.service.js';

/** The user's access to the route's business. */
export interface BusinessAccess {
  businessId: string;
  role: MembershipRole;
}

type AccessRequest = Request & {
  user?: SessionUser;
  businessAccess?: BusinessAccess;
};

const businessIdSchema = z.uuid();

/**
 * Requires an active membership of the session's user in the `:businessId`
 * of the route. Use after SessionGuard: `@UseGuards(SessionGuard, BusinessAccessGuard)`.
 * An unknown business answers 403 too, so ids cannot be probed. The
 * membership is read on every request: removing or deactivating it takes
 * effect at once.
 */
@Injectable()
export class BusinessAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AccessRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Not logged in');
    }
    const parsed = businessIdSchema.safeParse(request.params.businessId);
    if (!parsed.success) {
      throw new BadRequestException('businessId must be a UUID');
    }
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_businessId: { userId: request.user.id, businessId: parsed.data },
      },
      select: { businessId: true, role: true, active: true },
    });
    if (!membership?.active) {
      throw new ForbiddenException('No access to this business');
    }
    request.businessAccess = {
      businessId: membership.businessId,
      role: membership.role,
    };
    return true;
  }
}

/** The membership BusinessAccessGuard found for the route's business. */
export const CurrentBusiness = createParamDecorator(
  (_data: unknown, context: ExecutionContext): BusinessAccess => {
    const access = context
      .switchToHttp()
      .getRequest<AccessRequest>().businessAccess;
    if (!access) {
      throw new ForbiddenException('No access to this business');
    }
    return access;
  },
);
