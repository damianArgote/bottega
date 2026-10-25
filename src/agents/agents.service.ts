import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AgentProfile as StoredAgentProfile } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { diffProfiles, type FieldChange } from './agent-profile-diff.js';
import {
  type AgentProfileInput,
  type AgentSettingsInput,
  agentSettingsSchema,
} from './agent-profile.schema.js';
import { toAgentProfile, toProfileData, toSnapshot } from './agent-profile.js';

/** Versions listed by GET .../settings/agent/versions. */
export const VERSIONS_LISTED = 20;

/** What the admin API returns for a business's agent. */
export type AgentProfileView = AgentProfileInput & {
  businessId: string;
  version: number;
  updatedAt: Date;
};

/** What the backoffice returns: also who made the last change. */
export type AgentSettingsView = AgentProfileView & {
  /** null: the admin API, the seed or unknown. */
  updatedBy: { id: string; name: string } | null;
};

export interface AgentVersionView {
  version: number;
  createdAt: Date;
  /** null: the admin API, the seed or unknown. */
  author: { id: string; name: string } | null;
  /** Against the previous stored version (every field for the first one). */
  changes: FieldChange[];
}

type StoredWithAuthor = StoredAgentProfile & {
  updatedBy: { id: string; name: string } | null;
};

const withAuthor = { updatedBy: { select: { id: true, name: true } } };

function view(stored: StoredWithAuthor): AgentSettingsView {
  return {
    businessId: stored.businessId,
    ...toAgentProfile(stored),
    version: stored.version,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/**
 * Reads and changes a business's agent profile: the whole profile through
 * the admin API, all but `model` and `demoEnabled` through the backoffice.
 * Every change raises the version and stores its snapshot
 * (AgentProfileVersion), so it can be compared and restored.
 */
@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin API (its response has no author). */
  async get(businessId: string): Promise<AgentProfileView> {
    const { updatedBy: _author, ...profile } =
      await this.getSettings(businessId);
    void _author;
    return profile;
  }

  /** Backoffice: the profile and who made the last change. */
  async getSettings(businessId: string): Promise<AgentSettingsView> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { agentProfile: { include: withAuthor } },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    if (!business.agentProfile) {
      throw new NotFoundException('Agent profile not found');
    }
    return view(business.agentProfile);
  }

  /**
   * Admin API: replaces the whole profile (already validated by
   * agentProfileSchema). Creates it with version 1.
   */
  async put(
    businessId: string,
    input: AgentProfileInput,
  ): Promise<AgentProfileView> {
    const { updatedBy: _author, ...profile } = await this.write(
      businessId,
      input,
      null,
    );
    void _author;
    return profile;
  }

  /**
   * Backoffice: replaces the profile but `model` and `demoEnabled`, which
   * keep their values (a new profile starts with no model and no demo).
   */
  putSettings(
    businessId: string,
    input: AgentSettingsInput,
    userId: string,
  ): Promise<AgentSettingsView> {
    return this.write(businessId, input, userId);
  }

  /** The latest versions, newest first, each with what it changed. */
  async versions(businessId: string): Promise<AgentVersionView[]> {
    // One more than listed: the oldest listed one is compared with it.
    const rows = await this.prisma.agentProfileVersion.findMany({
      where: { businessId },
      orderBy: { version: 'desc' },
      take: VERSIONS_LISTED + 1,
      include: { createdBy: { select: { id: true, name: true } } },
    });
    const snapshot = (index: number) =>
      (rows[index]?.snapshot as Record<string, unknown> | undefined) ?? null;
    return rows.slice(0, VERSIONS_LISTED).map((row, index) => ({
      version: row.version,
      createdAt: row.createdAt,
      author: row.createdBy,
      changes: diffProfiles(snapshot(index + 1), snapshot(index)!),
    }));
  }

  /**
   * Saves a stored version again as a new version. `model` and
   * `demoEnabled` keep their current values. 404 for an unknown version,
   * 409 when the snapshot no longer passes the schema.
   */
  async restore(
    businessId: string,
    version: number,
    userId: string,
  ): Promise<AgentSettingsView> {
    const row = await this.prisma.agentProfileVersion.findUnique({
      where: { businessId_version: { businessId, version } },
    });
    if (!row) {
      throw new NotFoundException('Version not found');
    }
    // Strip: the snapshot also holds the admin-only fields, kept as they are.
    const parsed = agentSettingsSchema.strip().safeParse(row.snapshot);
    if (!parsed.success) {
      throw new ConflictException({
        message: 'This version can no longer be restored',
        code: 'VERSION_INVALID',
      });
    }
    return this.write(businessId, parsed.data, userId);
  }

  /**
   * Upserts the given fields (the rest keep their values), raising the
   * version, and stores the result as that version, in one transaction.
   */
  private async write(
    businessId: string,
    input: AgentSettingsInput | AgentProfileInput,
    userId: string | null,
  ): Promise<AgentSettingsView> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    const data = { ...toProfileData(input), updatedById: userId };
    const stored = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.agentProfile.upsert({
        where: { businessId },
        create: { businessId, ...data },
        update: { ...data, version: { increment: 1 } },
        include: withAuthor,
      });
      await tx.agentProfileVersion.create({
        data: {
          businessId,
          version: saved.version,
          snapshot: toSnapshot(saved),
          createdById: userId,
        },
      });
      return saved;
    });
    return view(stored);
  }
}
