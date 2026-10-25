import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../prisma/sql.js';
import { PasswordHasher } from './password-hasher.js';

export interface AddUserInput {
  email: string;
  name: string;
  password: string;
  role: MembershipRole;
}

/** Public view of a user: never includes the password hash. */
export const userView = {
  id: true,
  email: true,
  name: true,
  active: true,
} as const;

/** Emails are stored and compared trimmed and in lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Operators of businesses (no public sign-up: created by the admin API). */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
  ) {}

  /**
   * Adds a user to a business. A new email creates the user (argon2id
   * hash); an existing one only gets the membership, keeping its password
   * and name. 404 for an unknown business, 409 if already a member.
   */
  async addToBusiness(businessId: string, input: AddUserInput) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    const email = normalizeEmail(input.email);
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: userView,
    });
    // Hashing is slow: do it outside the transaction, only for new users.
    const passwordHash = existing
      ? null
      : await this.hasher.hash(input.password);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user =
          existing ??
          (await tx.user.create({
            data: { email, name: input.name, passwordHash: passwordHash! },
            select: userView,
          }));
        const membership = await tx.membership.create({
          data: { userId: user.id, businessId, role: input.role },
          select: { businessId: true, role: true },
        });
        return { user, membership, createdUser: !existing };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'This user already belongs to the business (or the email was just taken)',
        );
      }
      throw error;
    }
  }
}
