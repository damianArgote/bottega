import { z } from 'zod';

/** The inbox's fixed palette for tags (the web maps each to its colors). */
export const CONTACT_TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;

export const DEFAULT_CONTACT_TAG_COLOR = 'gray';

const KEY_MAX_LENGTH = 40;

/**
 * The tag's key from its name: snake_case ASCII ("Revendedor Mayorista" →
 * "revendedor_mayorista"). Generated once; a rename keeps it.
 */
export function tagKeyOf(name: string): string {
  const key = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, KEY_MAX_LENGTH)
    .replace(/_+$/, '');
  return key || 'etiqueta';
}

/** `base`, or `base_2`, `base_3`... the first one not in `taken`. */
export function uniqueTagKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const key = `${base.slice(0, KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(key)) {
      return key;
    }
  }
}

/** A tag's name: 1 to 40 characters once trimmed (spaces collapsed). */
const tagNameSchema = z
  .string()
  .transform((name) => name.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(40));
const botHintSchema = z
  .string()
  .transform((hint) => hint.replace(/\s+/g, ' ').trim())
  .pipe(z.string().max(300))
  .transform((hint) => hint || null)
  .nullable();
const assignedBySchema = z.enum(['BOT', 'PERSON']);
const colorSchema = z.enum(CONTACT_TAG_COLORS);

const hintOnlyForBot = {
  message: 'botHint is only for tags the bot puts (assignedBy BOT)',
  path: ['botHint'],
};

/** POST .../contact-tags */
export const newContactTagSchema = z
  .object({
    name: tagNameSchema,
    assignedBy: assignedBySchema,
    botHint: botHintSchema.optional(),
    color: colorSchema.default(DEFAULT_CONTACT_TAG_COLOR),
  })
  .strict()
  .refine((t) => t.assignedBy === 'BOT' || !t.botHint, hintOnlyForBot);

/** PATCH .../contact-tags/:tagId (a PERSON tag drops its hint). */
export const contactTagChangesSchema = z
  .object({
    name: tagNameSchema.optional(),
    assignedBy: assignedBySchema.optional(),
    botHint: botHintSchema.optional(),
    color: colorSchema.optional(),
  })
  .strict()
  .refine((t) => Object.values(t).some((v) => v !== undefined), {
    message: 'send name, assignedBy, botHint or color',
  })
  .refine((t) => t.assignedBy !== 'PERSON' || !t.botHint, hintOnlyForBot);

export const contactTagIdSchema = z.uuid();
export const contactIdSchema = z.uuid();

/** PUT .../contacts/:contactId/tags: every tag the contact keeps. */
export const contactTagsBodySchema = z
  .object({
    tagIds: z
      .array(z.uuid())
      .max(100)
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();

export type NewContactTag = z.infer<typeof newContactTagSchema>;
export type ContactTagChanges = z.infer<typeof contactTagChangesSchema>;
