import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  InMemoryLoginRateLimiter,
  LOGIN_RATE_LIMITER,
} from './login-rate-limiter.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionGuard } from './session.guard.js';
import { SessionTokens } from './session-tokens.js';
import { UsersService } from './users.service.js';

/** Operators, their memberships and their inbox sessions. */
@Module({
  controllers: [AuthController],
  providers: [
    PasswordHasher,
    UsersService,
    AuthService,
    SessionGuard,
    {
      provide: SessionTokens,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new SessionTokens(config.get('JWT_SECRET')),
    },
    {
      provide: LOGIN_RATE_LIMITER,
      // 5 attempts per minute per IP and per email.
      useValue: new InMemoryLoginRateLimiter({ max: 5, windowMs: 60_000 }),
    },
  ],
  exports: [PasswordHasher, UsersService, AuthService, SessionGuard],
})
export class AuthModule {}
