import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../prisma/sql.js';
import {
  keepsAnActiveOwner,
  type MemberChange,
  type MemberState,
} from './business-owners.js';
import { PasswordHasher } from './password-hasher.js';

export interface AddUserInput {
  email: string;
  name: string;
  password: string;
  role: MembershipRole;
  /** A temporary password: the web asks for a new one first. */
  mustChangePassword?: boolean;
}

/** A person of a business, as the backoffice lists them. */
export interface MemberView {
  id: string;
  email: string;
  name: string;
  role: MembershipRole;
  /** The membership: false means no access to this business. */
  active: boolean;
  mustChangePassword: boolean;
  addedAt: Date;
}

const memberSelect = {
  role: true,
  active: true,
  createdAt: true,
  user: {
    select: { id: true, email: true, name: true, mustChangePassword: true },
  },
} as const;

function memberView(row: {
  role: MembershipRole;
  active: boolean;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    mustChangePassword: boolean;
  };
}): MemberView {
  return {
    ...row.user,
    role: row.role,
    active: row.active,
    addedAt: row.createdAt,
  };
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
  private readonly logger = new Logger(UsersService.name);

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
            data: {
              email,
              name: input.name,
              passwordHash: passwordHash!,
              mustChangePassword: input.mustChangePassword ?? false,
            },
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

  /** The people of a business, in the order they were added. */
  async listMembers(businessId: string): Promise<MemberView[]> {
    const rows = await this.prisma.membership.findMany({
      where: { businessId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: memberSelect,
    });
    return rows.map(memberView);
  }

  /**
   * Backoffice: adds a person to the business. A new email gets a random
   * temporary password, returned only here (null for an existing user, who
   * keeps theirs), and must change it. 409 if already a member.
   */
  async addMember(
    businessId: string,
    input: Omit<AddUserInput, 'password' | 'mustChangePassword'>,
  ): Promise<{ user: MemberView; temporaryPassword: string | null }> {
    const temporaryPassword = randomBytes(12).toString('base64url');
    const { user, createdUser } = await this.addToBusiness(businessId, {
      ...input,
      password: temporaryPassword,
      mustChangePassword: true,
    });
    const row = await this.prisma.membership.findUniqueOrThrow({
      where: { userId_businessId: { userId: user.id, businessId } },
      select: memberSelect,
    });
    return {
      user: memberView(row),
      temporaryPassword: createdUser ? temporaryPassword : null,
    };
  }

  /** Grants or removes the staff role (admin API only). 404 if unknown. */
  async setStaff(userId: string, staff: boolean) {
    const result = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { staff },
    });
    if (result.count === 0) {
      throw new NotFoundException('User not found');
    }
    this.logger.log(
      `Staff role ${staff ? 'granted to' : 'removed from'} user ${userId}`,
    );
    return { id: userId, staff };
  }

  /**
   * Changes a person's role or active flag in the business. The business's
   * memberships are locked first, so two concurrent changes cannot leave it
   * without an active OWNER (409 `LAST_OWNER`). 404 if not a member.
   */
  async updateMember(
    businessId: string,
    change: MemberChange,
  ): Promise<MemberView> {
    return this.prisma.$transaction(async (tx) => {
      const members = await tx.$queryRaw<MemberState[]>`
        SELECT m.user_id AS "userId", m.role::text AS role,
          -- A disabled account cannot sign in: it counts as inactive.
          (m.active AND u.active) AS active
        FROM membership m
        JOIN app_user u ON u.id = m.user_id
        WHERE m.business_id = ${businessId}::uuid
        ORDER BY m.id
        FOR UPDATE OF m`;
      if (!members.some((m) => m.userId === change.userId)) {
        throw new NotFoundException('User not found in this business');
      }
      if (!keepsAnActiveOwner(members, change)) {
        throw new ConflictException({
          message: 'The business needs at least one active OWNER',
          code: 'LAST_OWNER',
        });
      }
      const row = await tx.membership.update({
        where: { userId_businessId: { userId: change.userId, businessId } },
        data: {
          ...(change.role ? { role: change.role } : {}),
          ...(change.active === undefined ? {} : { active: change.active }),
        },
        select: memberSelect,
      });
      return memberView(row);
    });
  }
}
