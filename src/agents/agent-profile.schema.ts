import { z } from 'zod';

export const MAX_PERSONA_LENGTH = 1_000;
export const MAX_BUSINESS_INFO_LENGTH = 8_000;
export const MAX_FAQ_ITEMS = 40;
export const MAX_LEAD_FIELDS = 8;

export const LEAD_FIELD_KINDS = ['text', 'phone', 'email', 'date'] as const;

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const text = (max: number) => z.string().trim().min(1).max(max);

/** One piece of data the agent asks for and stores in Lead.data[key]. */
export const leadFieldSchema = z
  .object({
    key: z
      .string()
      .max(40)
      .regex(SNAKE_CASE, 'must be snake_case (e.g. business_name)'),
    label: text(60),
    required: z.boolean(),
    kind: z.enum(LEAD_FIELD_KINDS),
  })
  .strict();

export type LeadField = z.infer<typeof leadFieldSchema>;

export const faqItemSchema = z
  .object({ question: text(300), answer: text(1_000) })
  .strict();

/**
 * A business's agent, editable through the admin API. Everything here is
 * business information for the prompt, never system instructions: the fixed
 * rules (COMMON_RULES) stay in code.
 */
export const agentProfileSchema = z
  .object({
    enabled: z.boolean(),
    /** How the bot introduces itself, e.g. "BotSuite, IA de BotSuite46". */
    botName: text(100),
    /** Tone and how it introduces itself, short. */
    persona: z.string().trim().max(MAX_PERSONA_LENGTH),
    /** Markdown: services, prices, hours, area, payment methods. */
    businessInfo: z.string().trim().max(MAX_BUSINESS_INFO_LENGTH),
    faq: z.array(faqItemSchema).max(MAX_FAQ_ITEMS),
    leadFields: z
      .array(leadFieldSchema)
      .max(MAX_LEAD_FIELDS)
      .refine(
        (fields) => new Set(fields.map((f) => f.key)).size === fields.length,
        'lead field keys must be unique',
      ),
    /** When to hand the conversation to a person. */
    handoffRules: z.string().trim().max(2_000),
    outOfHoursMessage: text(500).nullable(),
    /** OpenAI model id; null uses OPENAI_MODEL. */
    model: text(100).nullable(),
    /** Offers the fictitious barbershop demo ("demo" command). */
    demoEnabled: z.boolean(),
  })
  .strict();

export type AgentProfileInput = z.infer<typeof agentProfileSchema>;
