import { z } from 'zod';
import { ConversationMode } from '../../generated/prisma/client.js';
import {
  nullableString,
  strictObject,
  textArg,
  type ToolHandler,
} from './tool.js';

const schema = z.object({ reason: textArg(200) }).strict();

type HandoffArgs = z.infer<typeof schema>;

/** Pauses the bot and asks the team to take over (same path as "humano"). */
export const requestHandoffTool: ToolHandler<HandoffArgs> = {
  name: 'request_handoff',
  description:
    'Pasa la conversación a una persona del equipo y pausa el asistente. Usala si el usuario pide hablar con una persona, si la consulta no se puede resolver acá, o cuando eligió qué contratar o comprar y ya diste los datos obligatorios, para que el equipo cierre la venta.',
  allowedModes: [ConversationMode.COMMERCIAL, ConversationMode.DEMO],
  jsonSchema: strictObject({
    reason: nullableString('Motivo breve de la derivación (máx. 200).'),
  }),
  schema,
  plan(args) {
    return {
      ok: true,
      effect: { kind: 'request_handoff', reason: args.reason },
      output: { handoff: 'requested' },
    };
  },
};
