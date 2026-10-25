import type { PrismaClient } from '../generated/prisma/client.js';
import { DEFAULT_BUSINESS_SLUG } from '../lines/default-line.seed.js';
import {
  type AgentProfileInput,
  agentProfileSchema,
} from './agent-profile.schema.js';

export const DEFAULT_PERSONA =
  'Tono cálido y profesional. Atendés por WhatsApp a personas interesadas en un asistente con IA para su negocio.';

export const DEFAULT_HANDOFF_RULES =
  'Si la persona pide hablar con alguien del equipo, o si la consulta te supera.';

/** The lead fields the commercial bot asked for before profiles existed. */
export const DEFAULT_LEAD_FIELDS: AgentProfileInput['leadFields'] = [
  { key: 'name', label: 'Nombre', required: true, kind: 'text' },
  { key: 'business_name', label: 'Negocio', required: true, kind: 'text' },
  { key: 'industry', label: 'Rubro', required: true, kind: 'text' },
  { key: 'need', label: 'Necesidad', required: true, kind: 'text' },
];

export type AgentProfileSeedResult =
  { outcome: 'skipped' } | { outcome: 'seeded'; profileId: string };

/**
 * Creates the default business's (BotSuite46) agent profile from the
 * commercial content, once. Idempotent: an existing profile is left as is,
 * so edits made through the admin API survive every deploy. The bot name
 * starts as Business.botName; from then on the profile's name is the one used.
 */
export async function seedDefaultAgentProfile(
  prisma: PrismaClient,
  commercialInfo: string,
): Promise<AgentProfileSeedResult> {
  const business = await prisma.business.findUnique({
    where: { slug: DEFAULT_BUSINESS_SLUG },
  });
  if (!business) {
    return { outcome: 'skipped' };
  }
  const existing = await prisma.agentProfile.findUnique({
    where: { businessId: business.id },
    select: { id: true },
  });
  if (existing) {
    // Never re-validated or rewritten: content edits after the first run
    // cannot fail a deploy.
    return { outcome: 'seeded', profileId: existing.id };
  }
  const profile = agentProfileSchema.parse({
    enabled: true,
    botName: business.botName,
    persona: DEFAULT_PERSONA,
    businessInfo: commercialInfo,
    faq: [],
    leadFields: DEFAULT_LEAD_FIELDS,
    handoffRules: DEFAULT_HANDOFF_RULES,
    outOfHoursMessage: null,
    model: null,
    demoEnabled: true,
  } satisfies AgentProfileInput);

  // Upsert so a concurrent first run cannot fail on the unique business id.
  const { id } = await prisma.agentProfile.upsert({
    where: { businessId: business.id },
    create: { businessId: business.id, ...profile },
    update: {},
  });
  return { outcome: 'seeded', profileId: id };
}
