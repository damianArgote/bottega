import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readCookie, SESSION_COOKIE } from './auth-cookies.js';
import { AuthService, type SessionUser } from './auth.service.js';

type SessionRequest = Request & { user?: SessionUser };

/** Requires a valid session cookie of an active user; sets `request.user`. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const user = await this.auth.userForSession(
      readCookie(request.cookies, SESSION_COOKIE),
    );
    if (!user) {
      throw new UnauthorizedException('Not logged in');
    }
    request.user = user;
    return true;
  }
}

/** The user SessionGuard authenticated. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => {
    const user = context.switchToHttp().getRequest<SessionRequest>().user;
    if (!user) {
      throw new UnauthorizedException('Not logged in');
    }
    return user;
  },
);
