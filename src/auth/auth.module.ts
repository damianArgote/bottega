import { Module } from '@nestjs/common';
import { PasswordHasher } from './password-hasher.js';
import { UsersService } from './users.service.js';

/** Operators, their memberships and (prompt 03) their sessions. */
@Module({
  providers: [PasswordHasher, UsersService],
  exports: [PasswordHasher, UsersService],
})
export class AuthModule {}
