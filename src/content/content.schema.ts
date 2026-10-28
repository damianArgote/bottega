import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const text = z.string().trim().min(1);

export const aestheticsDemoSchema = z
  .object({
    scenario: z.literal('aesthetics'),
    // Demo data must always be declared fictitious.
    fictitious: z.literal(true),
    name: text,
    description: text,
    address: text,
    instagram: text,
    /** Online booking page the receptionist sends (no live availability). */
    bookingUrl: z.url(),
    currency: z.literal('ARS'),
    services: z
      .array(
        z
          .object({
            category: text,
            name: text,
            priceArs: z.number().int().positive(),
            durationMinutes: z.number().int().positive(),
            description: text,
          })
          .strict(),
      )
      .min(1),
    openingHours: z
      .array(z.object({ days: text, hours: text }).strict())
      .min(1),
    policies: z.array(z.object({ question: text, answer: text }).strict()),
  })
  .strict();

export type AestheticsDemo = z.infer<typeof aestheticsDemoSchema>;

export const VEHICLE_CATEGORIES = ['A', 'B', 'C'] as const;

const priceArs = z.number().int().positive();

export const insuranceDemoSchema = z
  .object({
    scenario: z.literal('insurance'),
    // Demo data must always be declared fictitious.
    fictitious: z.literal(true),
    name: text,
    description: text,
    currency: z.literal('ARS'),
    /** Oldest model year the demo quotes. */
    minYear: z.number().int().min(1990),
    gncSurchargePercent: z.number().int().min(0).max(100),
    zones: z
      .array(
        z
          .object({
            name: text,
            factorPercent: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    vehicles: z
      .array(
        z
          .object({
            make: text,
            model: text,
            versions: z.array(text).min(1),
            category: z.enum(VEHICLE_CATEGORIES),
          })
          .strict(),
      )
      .min(1),
    plans: z
      .array(
        z
          .object({
            name: text,
            summary: text,
            coverages: z.array(text).min(1),
            notIncluded: z.array(text),
            deductibleArs: priceArs.nullable(),
            conditions: z.array(text),
            monthlyArs: z
              .object({ A: priceArs, B: priceArs, C: priceArs })
              .strict(),
            maxVehicleAgeYears: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

export type InsuranceDemo = z.infer<typeof insuranceDemoSchema>;

/** Content of one fictitious demo business, by scenario. */
export type DemoContent = AestheticsDemo | InsuranceDemo;

/** Markdown knowledge with the editing-notes HTML comments removed. */
export const commercialInfoSchema = z
  .string()
  .transform((raw) => raw.replace(/<!--[\s\S]*?-->/g, '').trim())
  .pipe(z.string().min(1, 'must contain text outside comments'));

export interface Content {
  commercialInfo: string;
  aesthetics: AestheticsDemo;
  insurance: InsuranceDemo;
}

export const CONTENT_FILES = {
  commercialInfo: 'commercial-info.md',
  aesthetics: join('demos', 'aesthetics.json'),
  insurance: join('demos', 'insurance.json'),
} as const;

export class ContentValidationError extends Error {
  constructor(file: string, problems: readonly string[]) {
    super(
      `Invalid content file ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'ContentValidationError';
  }
}

function check<T>(file: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new ContentValidationError(
    file,
    result.error.issues.map(
      (issue) =>
        `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    ),
  );
}

function read(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch (error) {
    throw new ContentValidationError(file, [
      `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
    ]);
  }
}

function json(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ContentValidationError(file, ['is not valid JSON']);
  }
}

/** Parses the content files. Throws {@link ContentValidationError}. */
export function parseContent(files: Record<keyof Content, string>): Content {
  return {
    commercialInfo: check(
      CONTENT_FILES.commercialInfo,
      commercialInfoSchema,
      files.commercialInfo,
    ),
    aesthetics: check(
      CONTENT_FILES.aesthetics,
      aestheticsDemoSchema,
      json(CONTENT_FILES.aesthetics, files.aesthetics),
    ),
    insurance: check(
      CONTENT_FILES.insurance,
      insuranceDemoSchema,
      json(CONTENT_FILES.insurance, files.insurance),
    ),
  };
}

/** Reads and validates every content file under `dir`. */
export function loadContent(dir: string): Content {
  return parseContent({
    commercialInfo: read(dir, CONTENT_FILES.commercialInfo),
    aesthetics: read(dir, CONTENT_FILES.aesthetics),
    insurance: read(dir, CONTENT_FILES.insurance),
  });
}
