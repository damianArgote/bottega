import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SessionUser } from './auth.service.js';

/**
 * Requires the BotSuite46 team role. Use after SessionGuard:
 * `@UseGuards(SessionGuard, StaffGuard)`. Reads the role from the database
 * on every request (never from the session token), so removing it cuts
 * access on the next request.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<{ user?: SessionUser }>()
      .user?.id;
    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { staff: true, active: true },
        })
      : null;
    if (!user?.active || !user.staff) {
      throw new ForbiddenException('Only the BotSuite46 team can do this');
    }
    return true;
  }
}
