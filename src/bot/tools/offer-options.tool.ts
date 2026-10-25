import { z } from 'zod';
import { ConversationMode } from '../../generated/prisma/client.js';
import { MAX_BUTTON_TITLE, MAX_BUTTONS } from '../reply-buttons.js';
import { textArg, type ToolHandler } from './tool.js';

const schema = z
  .object({
    options: z
      .array(textArg(MAX_BUTTON_TITLE))
      .min(2)
      .max(MAX_BUTTONS)
      .refine((titles) => titles.every((t) => t !== null), {
        message: 'options cannot be empty',
      })
      .refine(
        (titles) =>
          new Set(titles.map((t) => t?.toLowerCase())).size === titles.length,
        { message: 'options must be different' },
      ),
  })
  .strict();

type OfferArgs = z.infer<typeof schema>;

/**
 * Shows 2 or 3 choices as WhatsApp reply buttons under the reply (e.g. the
 * plans) instead of asking "which one do you prefer?". Tapping one sends its
 * title back as the user's text. Once per reply.
 */
export const offerOptionsTool: ToolHandler<OfferArgs> = {
  name: 'offer_options',
  description:
    'Muestra 2 o 3 opciones como botones debajo de tu respuesta (por ejemplo, los planes). Usala cuando le propongas elegir entre opciones concretas, en lugar de preguntar cuál prefiere. Cada opción, de 20 caracteres como máximo. Igual escribí tu respuesta en texto.',
  allowedModes: [ConversationMode.COMMERCIAL, ConversationMode.DEMO],
  jsonSchema: {
    type: 'object',
    properties: {
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Entre 2 y 3 opciones, cada una de 20 caracteres como máximo.',
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  schema,
  plan(args, ctx) {
    if (ctx.planned.some((e) => e.kind === 'reply_buttons')) {
      return { ok: false, error: 'Ya ofreciste opciones en esta respuesta.' };
    }
    const titles = args.options.filter((t): t is string => t !== null);
    return {
      ok: true,
      effect: {
        kind: 'reply_buttons',
        buttons: titles.map((title, i) => ({ id: `option_${i + 1}`, title })),
      },
      output: { offered: titles },
    };
  },
};
