import { z } from 'zod';
import type { BarbershopDemo } from '../../content/content.schema.js';
import type { DemoRequestInput } from '../../demos/demos.service.js';
import { ConversationMode } from '../../generated/prisma/client.js';
import {
  nullableString,
  strictObject,
  textArg,
  type ToolHandler,
} from './tool.js';

const schema = z
  .object({
    customerName: textArg(100),
    service: textArg(100),
    preferredDate: textArg(100),
    preferredTime: textArg(100),
    notes: textArg(300),
  })
  .strict();

type DemoArgs = z.infer<typeof schema>;

const FIELD_LABELS: Record<keyof DemoArgs, string> = {
  customerName: 'nombre',
  service: 'servicio',
  preferredDate: 'día',
  preferredTime: 'horario',
  notes: 'notas',
};

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Canonical service name, matched case- and accent-insensitively. */
export function findService(
  barbershop: BarbershopDemo,
  name: string,
): string | null {
  const wanted = fold(name);
  return barbershop.services.find((s) => fold(s.name) === wanted)?.name ?? null;
}

/**
 * Fictitious booking request in the barbershop demo. The service must be one
 * of the demo's services and every required booking field must be present.
 */
export const registerDemoRequestTool: ToolHandler<DemoArgs> = {
  name: 'register_demo_request',
  description:
    'Registra una solicitud de turno FICTICIA de la demo (no es una reserva real ni un pago). Llamala solo cuando tengas todos los datos obligatorios confirmados por el usuario.',
  allowedModes: [ConversationMode.DEMO],
  jsonSchema: strictObject({
    customerName: nullableString('Nombre del cliente (máx. 100 caracteres).'),
    service: nullableString(
      'Nombre exacto de uno de los servicios de la barbería.',
    ),
    preferredDate: nullableString('Día preferido, como lo dijo el usuario.'),
    preferredTime: nullableString(
      'Horario preferido, como lo dijo el usuario.',
    ),
    notes: nullableString('Comentarios opcionales (máx. 300 caracteres).'),
  }),
  schema,
  plan(args, ctx) {
    if (ctx.planned.some((e) => e.kind === 'register_demo_request')) {
      return {
        ok: false,
        error: 'Ya se registró una solicitud en este mensaje.',
      };
    }
    const missing = ctx.barbershop.bookingFields.filter((f) => !args[f]);
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Faltan datos: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}.`,
      };
    }
    let service: string | null = null;
    if (args.service) {
      service = findService(ctx.barbershop, args.service);
      if (!service) {
        return {
          ok: false,
          error: `"${args.service}" no es un servicio de la barbería. Servicios: ${ctx.barbershop.services.map((s) => s.name).join(', ')}.`,
        };
      }
    }
    const request: DemoRequestInput = {};
    if (args.customerName) request.customerName = args.customerName;
    if (service) request.service = service;
    if (args.preferredDate) request.preferredDate = args.preferredDate;
    if (args.preferredTime) request.preferredTime = args.preferredTime;
    if (args.notes) request.notes = args.notes;
    return {
      ok: true,
      effect: { kind: 'register_demo_request', request },
      output: {
        registered: request,
        fictitious: true,
        note: 'Solicitud ficticia de demo: no es una reserva real ni un pago.',
      },
    };
  },
};
