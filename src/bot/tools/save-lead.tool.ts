import { z } from 'zod';
import { ConversationMode } from '../../generated/prisma/client.js';
import type { LeadFields } from '../../leads/leads.service.js';
import {
  nullableString,
  strictObject,
  textArg,
  type ToolHandler,
} from './tool.js';

const MAX = 200;

const schema = z
  .object({
    name: textArg(MAX),
    businessName: textArg(MAX),
    industry: textArg(MAX),
    need: textArg(MAX),
    contactNotes: textArg(MAX),
  })
  .strict();

type SaveLeadArgs = z.infer<typeof schema>;

/** Real prospect data, commercial mode only. Merges, never blanks. */
export const saveLeadTool: ToolHandler<SaveLeadArgs> = {
  name: 'save_lead',
  description:
    'Guarda datos del prospecto que el usuario dio en la conversación. Pasá solo los datos nuevos o corregidos y null en el resto. Nunca inventes datos.',
  allowedModes: [ConversationMode.COMMERCIAL],
  jsonSchema: strictObject({
    name: nullableString('Nombre de la persona (máx. 200 caracteres).'),
    businessName: nullableString('Nombre del negocio (máx. 200 caracteres).'),
    industry: nullableString('Rubro del negocio (máx. 200 caracteres).'),
    need: nullableString(
      'Qué necesita resolver con el asistente (máx. 200 caracteres).',
    ),
    contactNotes: nullableString(
      'Otros datos de contacto o comentarios (máx. 200 caracteres).',
    ),
  }),
  schema,
  plan(args) {
    const fields: LeadFields = {};
    for (const [key, value] of Object.entries(args)) {
      if (value) {
        fields[key as keyof LeadFields] = value;
      }
    }
    const saved = Object.keys(fields);
    if (saved.length === 0) {
      return { ok: false, error: 'No llegó ningún dato para guardar.' };
    }
    return {
      ok: true,
      effect: { kind: 'save_lead', fields },
      output: { saved },
    };
  },
};
