import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const text = z.string().trim().min(1);

export const BOOKING_FIELDS = [
  'customerName',
  'service',
  'preferredDate',
  'preferredTime',
] as const;

export const barbershopDemoSchema = z
  .object({
    scenario: z.literal('barbershop'),
    // Demo data must always be declared fictitious.
    fictitious: z.literal(true),
    name: text,
    description: text,
    address: text,
    currency: z.literal('ARS'),
    services: z
      .array(
        z
          .object({
            name: text,
            priceArs: z.number().int().positive(),
            durationMinutes: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    openingHours: z
      .array(z.object({ days: text, hours: text }).strict())
      .min(1),
    faq: z.array(z.object({ question: text, answer: text }).strict()),
    bookingFields: z.array(z.enum(BOOKING_FIELDS)).min(1),
  })
  .strict();

export type BarbershopDemo = z.infer<typeof barbershopDemoSchema>;

/** Markdown knowledge with the editing-notes HTML comments removed. */
export const commercialInfoSchema = z
  .string()
  .transform((raw) => raw.replace(/<!--[\s\S]*?-->/g, '').trim())
  .pipe(z.string().min(1, 'must contain text outside comments'));

export interface Content {
  commercialInfo: string;
  barbershop: BarbershopDemo;
}

export const CONTENT_FILES = {
  commercialInfo: 'commercial-info.md',
  barbershop: join('demos', 'barbershop.json'),
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

/** Parses the content files. Throws {@link ContentValidationError}. */
export function parseContent(files: {
  commercialInfo: string;
  barbershop: string;
}): Content {
  let barbershopJson: unknown;
  try {
    barbershopJson = JSON.parse(files.barbershop);
  } catch {
    throw new ContentValidationError(CONTENT_FILES.barbershop, [
      'is not valid JSON',
    ]);
  }
  return {
    commercialInfo: check(
      CONTENT_FILES.commercialInfo,
      commercialInfoSchema,
      files.commercialInfo,
    ),
    barbershop: check(
      CONTENT_FILES.barbershop,
      barbershopDemoSchema,
      barbershopJson,
    ),
  };
}

/** Reads and validates every content file under `dir`. */
export function loadContent(dir: string): Content {
  return parseContent({
    commercialInfo: read(dir, CONTENT_FILES.commercialInfo),
    barbershop: read(dir, CONTENT_FILES.barbershop),
  });
}
