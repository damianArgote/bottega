import { z } from 'zod';
import { ConversationMode } from '../../generated/prisma/client.js';
import {
  INSURANCE_DISCLAIMER,
  quoteInsurance,
} from '../../demos/insurance-quote.js';
import {
  nullableString,
  strictObject,
  textArg,
  type ToolHandler,
} from './tool.js';

const schema = z
  .object({
    model: textArg(60),
    year: z.number().int().nullable(),
    zone: textArg(40),
    gnc: z.boolean().nullable(),
  })
  .strict();

type QuoteArgs = z.infer<typeof schema>;

const FIELD_LABELS: Record<keyof QuoteArgs, string> = {
  model: 'modelo',
  year: 'año',
  zone: 'zona',
  gnc: 'si tiene GNC',
};

/**
 * Simulated car insurance prices from the demo table (insurance demo only).
 * The model shows these numbers; it never makes up a price.
 */
export const quoteInsuranceTool: ToolHandler<QuoteArgs> = {
  name: 'quote_insurance',
  description:
    'Calcula la cotización SIMULADA de la demo para un auto: devuelve los planes disponibles con su precio mensual y franquicia. Es la única fuente de precios: llamala de nuevo si cambia el auto, el año, la zona o el GNC.',
  allowedModes: [ConversationMode.DEMO],
  jsonSchema: strictObject({
    model: nullableString('Modelo del auto, por ejemplo "Gol Trend".'),
    year: {
      type: ['integer', 'null'],
      description: 'Año del modelo, por ejemplo 2018.',
    },
    zone: nullableString(
      'Zona de la tabla donde vive el usuario (CABA, GBA o Interior), deducida de su localidad.',
    ),
    gnc: {
      type: ['boolean', 'null'],
      description: 'true si el auto tiene GNC.',
    },
  }),
  schema,
  plan(args, ctx) {
    const demo = ctx.demo;
    if (demo?.scenario !== 'insurance') {
      return { ok: false, error: 'No hay un cotizador en esta demo.' };
    }
    const missing = (Object.keys(FIELD_LABELS) as (keyof QuoteArgs)[]).filter(
      (f) => args[f] === null,
    );
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Faltan datos para cotizar: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}. Pedíselos al usuario.`,
      };
    }
    const result = quoteInsurance(
      demo,
      {
        model: args.model ?? '',
        year: args.year ?? 0,
        zone: args.zone ?? '',
        gnc: args.gnc ?? false,
      },
      new Date().getFullYear(),
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      effect: { kind: 'insurance_quote', quote: result.quote },
      output: {
        ...result.quote,
        currency: demo.currency,
        disclaimer: INSURANCE_DISCLAIMER,
      },
    };
  },
};
