import { Injectable, NotFoundException } from '@nestjs/common';
import type { AgentProfile as StoredAgentProfile } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AgentProfileInput } from './agent-profile.schema.js';
import { toAgentProfile, toProfileData } from './agent-profile.js';

/** What the admin API returns for a business's agent. */
export type AgentProfileView = AgentProfileInput & {
  businessId: string;
  version: number;
  updatedAt: Date;
};

function view(stored: StoredAgentProfile): AgentProfileView {
  return {
    businessId: stored.businessId,
    ...toAgentProfile(stored),
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

/** Reads and replaces a business's agent profile (admin API). */
@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(businessId: string): Promise<AgentProfileView> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { agentProfile: true },
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
   * Replaces the whole profile (already validated by agentProfileSchema).
   * Creates it with version 1; every later put raises the version by one.
   */
  async put(
    businessId: string,
    input: AgentProfileInput,
  ): Promise<AgentProfileView> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    const stored = await this.prisma.agentProfile.upsert({
      where: { businessId },
      create: { businessId, ...toProfileData(input) },
      update: { ...toProfileData(input), version: { increment: 1 } },
    });
    return view(stored);
  }
}
