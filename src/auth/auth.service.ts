import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  LOGIN_RATE_LIMITER,
  type LoginRateLimiter,
} from './login-rate-limiter.js';
import { PasswordHasher } from './password-hasher.js';
import {
  hashRefreshToken,
  newRefreshToken,
  REFRESH_TTL_SECONDS,
  SessionTokens,
} from './session-tokens.js';
import { normalizeEmail } from './users.service.js';

/** The user a session belongs to (what the API returns about them). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** A temporary password: the web asks for a new one before the inbox. */
  mustChangePassword: boolean;
}

export interface IssuedSession {
  user: SessionUser;
  session: string;
  refresh: string;
}

const sessionUser = {
  id: true,
  email: true,
  name: true,
  mustChangePassword: true,
} as const;

/** Same message for every login failure, so emails cannot be probed. */
const INVALID_LOGIN = 'Invalid email or password';

/**
 * Inbox sessions: login with email and password, a 15-minute session JWT
 * and a 14-day refresh token stored as a hash (rotated on refresh, revoked
 * on logout).
 */
@Injectable()
export class AuthService {
  /** Verified against for unknown emails, so they take as long as wrong passwords. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: SessionTokens,
    @Inject(LOGIN_RATE_LIMITER) private readonly limiter: LoginRateLimiter,
  ) {}

  async login(
    email: string,
    password: string,
    ip: string,
  ): Promise<IssuedSession> {
    const normalized = normalizeEmail(email);
    if (!this.limiter.attempt([`ip:${ip}`, `email:${normalized}`])) {
      throw new HttpException(
        'Too many login attempts, try again in a minute',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { ...sessionUser, active: true, passwordHash: true },
    });
    if (!user) {
      this.dummyHash ??= this.hasher.hash('timing-equalizer-password');
      await this.hasher.verify(await this.dummyHash, password);
      throw new UnauthorizedException(INVALID_LOGIN);
    }
    const valid = await this.hasher.verify(user.passwordHash, password);
    if (!valid || !user.active) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }
    const { id, name, mustChangePassword } = user;
    return this.issue({ id, email: user.email, name, mustChangePassword });
  }

  /**
   * Rotates a refresh token: the old one is revoked (only once, even with
   * concurrent requests) and a new session is issued. 401 for an unknown,
   * revoked or expired token, or an inactive user.
   */
  async refresh(token: string | undefined): Promise<IssuedSession> {
    const expired = new UnauthorizedException('Session expired');
    if (!token) {
      throw expired;
    }
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      include: { user: { select: { ...sessionUser, active: true } } },
    });
    if (
      !row ||
      row.revokedAt !== null ||
      row.expiresAt <= new Date() ||
      !row.user.active
    ) {
      throw expired;
    }
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count !== 1) {
      throw expired;
    }
    const { id, email, name, mustChangePassword } = row.user;
    return this.issue({ id, email, name, mustChangePassword });
  }

  /** Revokes the refresh token, if any. */
  async logout(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** The active user behind a session JWT, or null. */
  async userForSession(token: string | undefined): Promise<SessionUser | null> {
    const userId = token ? await this.tokens.verify(token) : null;
    if (!userId) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...sessionUser, active: true },
    });
    if (!user?.active) {
      return null;
    }
    const { id, email, name, mustChangePassword } = user;
    return { id, email, name, mustChangePassword };
  }

  /**
   * POST /auth/change-password: checks the current password (401), saves
   * the new one, clears mustChangePassword, ends every other session (all
   * refresh tokens revoked) and returns a fresh session for this one.
   */
  async changePassword(
    user: SessionUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<IssuedSession> {
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'The new password must be different from the current one',
      );
    }
    const stored = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!(await this.hasher.verify(stored.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Invalid password');
    }
    const passwordHash = await this.hasher.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return this.issue({ ...user, mustChangePassword: false });
  }

  /** GET /auth/me: the user, their businesses and their role in each. */
  async me(user: SessionUser) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        business: { select: { id: true, name: true, slug: true } },
      },
    });
    return {
      user,
      businesses: memberships.map((m) => ({ ...m.business, role: m.role })),
    };
  }

  private async issue(user: SessionUser): Promise<IssuedSession> {
    const refresh = newRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refresh),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    return { user, session: await this.tokens.sign(user.id), refresh };
  }
}
