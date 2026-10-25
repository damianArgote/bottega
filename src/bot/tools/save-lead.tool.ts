import { z } from 'zod';
import type { LeadField } from '../../agents/agent-profile.schema.js';
import { ConversationMode } from '../../generated/prisma/client.js';
import type { LeadValues } from '../../leads/lead-values.js';
import {
  nullableString,
  strictObject,
  textArg,
  type ToolHandler,
} from './tool.js';

const MAX = 200;

const PHONE_SEPARATORS = /[\s().-]/g;
const PHONE = /^\+?\d{6,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Argument schema and model-facing hint for each lead field kind. */
const KINDS: Record<
  LeadField['kind'],
  {
    /** Longest accepted value, as the user typed it. */
    max: number;
    arg: (max: number) => z.ZodType<string | null, unknown>;
    hint: string;
  }
> = {
  text: { max: MAX, arg: textArg, hint: '' },
  // Stored as digits with an optional leading "+".
  phone: {
    max: 40,
    arg: (max) =>
      textArg(max)
        .transform((v) => (v === null ? null : v.replace(PHONE_SEPARATORS, '')))
        .refine((v) => v === null || PHONE.test(v), {
          message: 'must be a phone number',
        }),
    hint: ' Un número de teléfono, con característica.',
  },
  email: {
    max: MAX,
    arg: (max) =>
      textArg(max)
        .transform((v) => (v === null ? null : v.toLowerCase()))
        .refine((v) => v === null || EMAIL.test(v), {
          message: 'must be an email address',
        }),
    hint: ' Una dirección de email.',
  },
  date: {
    max: 100,
    arg: textArg,
    hint: ' Una fecha, como la dijo el usuario.',
  },
};

type SaveLeadArgs = Record<string, string | null>;

/**
 * save_lead for one business: its JSON Schema and validation are generated
 * from the profile's lead fields, so only declared keys can be stored. Real
 * prospect data, commercial mode only. Merges, never blanks.
 */
export function saveLeadToolFor(
  fields: readonly LeadField[],
): ToolHandler<SaveLeadArgs> {
  return {
    name: 'save_lead',
    description:
      'Guarda datos del prospecto que el usuario dio en la conversación. Pasá solo los datos nuevos o corregidos y null en el resto. Nunca inventes datos.',
    allowedModes: [ConversationMode.COMMERCIAL],
    jsonSchema: strictObject(
      Object.fromEntries(
        fields.map((f) => [
          f.key,
          nullableString(
            `${f.label}.${KINDS[f.kind].hint} (máx. ${KINDS[f.kind].max} caracteres).`,
          ),
        ]),
      ),
    ),
    schema: z
      .object(
        Object.fromEntries(
          fields.map((f) => [f.key, KINDS[f.kind].arg(KINDS[f.kind].max)]),
        ),
      )
      .strict(),
    plan(args) {
      const values: LeadValues = {};
      for (const [key, value] of Object.entries(args)) {
        if (value) {
          values[key] = value;
        }
      }
      const saved = Object.keys(values);
      if (saved.length === 0) {
        return { ok: false, error: 'No llegó ningún dato para guardar.' };
      }
      return {
        ok: true,
        effect: { kind: 'save_lead', values },
        output: { saved },
      };
    },
  };
}
