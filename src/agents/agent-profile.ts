import type { Prisma } from '../generated/prisma/client.js';
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
 * The agent profile of the conversation's business. Stored profiles are
 * parsed with {@link agentProfileSchema} again, so the jsonb columns are typed
 * and checked before they reach the prompt.
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
            select: { id: true, botName: true, agentProfile: true },
          },
        },
      },
    },
  });
  const business = conversation?.line.business;
  if (!business) {
    return fallbackAgentProfile(DEFAULT_BOT_NAME);
  }
  const stored = business.agentProfile;
  if (!stored) {
    return fallbackAgentProfile(business.botName);
  }
  const parsed = agentProfileSchema.safeParse({
    enabled: stored.enabled,
    botName: stored.botName,
    persona: stored.persona,
    businessInfo: stored.businessInfo,
    faq: stored.faq,
    leadFields: stored.leadFields,
    handoffRules: stored.handoffRules,
    outOfHoursMessage: stored.outOfHoursMessage,
    model: stored.model,
    demoEnabled: stored.demoEnabled,
  });
  if (!parsed.success) {
    throw new AgentProfileInvalidError(business.id);
  }
  return { ...parsed.data, version: stored.version };
}
