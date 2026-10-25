import {
  type AgentProfile as StoredAgentProfile,
  Prisma,
} from '../generated/prisma/client.js';
import { DEFAULT_BOT_NAME } from '../lines/default-line.seed.js';
import {
  type AgentProfileInput,
  agentProfileSchema,
} from './agent-profile.schema.js';

/** The agent a conversation is answered with. */
export interface AgentProfile extends AgentProfileInput {
  /** AgentProfile.version; null when the business has no stored profile. */
  version: number | null;
}

/**
 * Agent of a business with no stored profile yet (created through the admin
 * API before its agent was configured): switched off, no demo.
 */
export function fallbackAgentProfile(botName: string): AgentProfile {
  return {
    enabled: false,
    botName,
    persona: '',
    businessInfo: '',
    faq: [],
    leadFields: [],
    handoffRules: '',
    outOfHoursMessage: null,
    openingHours: null,
    model: null,
    demoEnabled: false,
    version: null,
  };
}

/** Raised when a stored profile no longer passes the schema. */
export class AgentProfileInvalidError extends Error {
  constructor(businessId: string) {
    super(`agent_profile_invalid business=${businessId}`);
    this.name = 'AgentProfileInvalidError';
  }
}

/** A client or a transaction. */
type Db = Pick<Prisma.TransactionClient, 'conversation'>;

/**
 * The agent profile of the conversation's business (see
 * {@link toAgentProfile}), or the switched-off fallback when it has none.
 */
export async function loadAgentProfile(
  db: Db,
  conversationId: string,
): Promise<AgentProfile> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      line: {
        select: {
          business: {
            select: { botName: true, agentProfile: true },
          },
        },
      },
    },
  });
  const business = conversation?.line.business;
  if (!business) {
    return fallbackAgentProfile(DEFAULT_BOT_NAME);
  }
  return business.agentProfile
    ? toAgentProfile(business.agentProfile)
    : fallbackAgentProfile(business.botName);
}

/**
 * The stored profile of a business: null when the business exists but has
 * no profile, undefined when there is no such business.
 */
export async function loadBusinessAgentProfile(
  db: Pick<Prisma.TransactionClient, 'business'>,
  businessId: string,
): Promise<AgentProfile | null | undefined> {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { agentProfile: true },
  });
  if (!business) {
    return undefined;
  }
  return business.agentProfile ? toAgentProfile(business.agentProfile) : null;
}

/** A stored row, parsed again so its jsonb columns are typed and checked. */
export function toAgentProfile(stored: StoredAgentProfile): AgentProfile {
  const parsed = agentProfileSchema.safeParse({
    enabled: stored.enabled,
    botName: stored.botName,
    persona: stored.persona,
    businessInfo: stored.businessInfo,
    faq: stored.faq,
    leadFields: stored.leadFields,
    handoffRules: stored.handoffRules,
    outOfHoursMessage: stored.outOfHoursMessage,
    openingHours: stored.openingHours,
    model: stored.model,
    demoEnabled: stored.demoEnabled,
  });
  if (!parsed.success) {
    throw new AgentProfileInvalidError(stored.businessId);
  }
  return { ...parsed.data, version: stored.version };
}

/** A validated profile as Prisma write data (a null jsonb is DbNull). */
export function toProfileData<
  T extends Pick<AgentProfileInput, 'openingHours'>,
>(input: T) {
  return { ...input, openingHours: input.openingHours ?? Prisma.DbNull };
}

/** What a version stores: the profile's fields, without its version. */
export function toSnapshot(stored: StoredAgentProfile): Prisma.InputJsonObject {
  const profile: Partial<AgentProfile> = { ...toAgentProfile(stored) };
  delete profile.version;
  return profile;
}
