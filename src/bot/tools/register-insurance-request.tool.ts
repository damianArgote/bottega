import { z } from 'zod';
import type { DemoRequestInput } from '../../demos/demos.service.js';
import { findPlan, quoteInsurance } from '../../demos/insurance-quote.js';
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
    model: textArg(60),
    version: textArg(60),
    year: z.number().int().nullable(),
    location: textArg(100),
    zone: textArg(40),
    gnc: z.boolean().nullable(),
    priority: textArg(100),
    plan: textArg(60),
    contactPreference: textArg(150),
  })
  .strict();

type InsuranceArgs = z.infer<typeof schema>;

const REQUIRED: Partial<Record<keyof InsuranceArgs, string>> = {
  customerName: 'nombre',
  model: 'modelo',
  version: 'versión',
  year: 'año',
  location: 'localidad',
  zone: 'zona',
  gnc: 'si tiene GNC',
  plan: 'plan elegido',
};

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Closes the insurance demo: stores the fictitious quote request the user
 * chose (the price is computed again from the demo table, never taken from
 * the model) and hands the conversation off so an advisor follows up.
 */
export const registerInsuranceRequestTool: ToolHandler<InsuranceArgs> = {
  name: 'register_demo_request',
  description:
    'Deja lista la consulta FICTICIA de la demo para un asesor y pasa la conversación al equipo. Llamala solo cuando el usuario eligió un plan y te dio su nombre, con todos los datos del auto confirmados. No es una póliza ni un pago.',
  allowedModes: [ConversationMode.DEMO],
  jsonSchema: strictObject({
    customerName: nullableString('Nombre del cliente (máx. 100 caracteres).'),
    model: nullableString('Modelo del auto, por ejemplo "Gol Trend".'),
    version: nullableString('Versión del auto, una de las de la tabla.'),
    year: { type: ['integer', 'null'], description: 'Año del modelo.' },
    location: nullableString('Localidad o código postal, como lo dijo.'),
    zone: nullableString('Zona de la tabla: CABA, GBA o Interior.'),
    gnc: { type: ['boolean', 'null'], description: 'true si tiene GNC.' },
    priority: nullableString(
      'Qué busca: pagar menos, mejor cobertura o comparar.',
    ),
    plan: nullableString('Nombre exacto del plan que eligió.'),
    contactPreference: nullableString(
      'Cómo y cuándo prefiere que lo contacte el asesor, si lo dijo.',
    ),
  }),
  schema,
  plan(args, ctx) {
    const demo = ctx.demo;
    if (demo?.scenario !== 'insurance') {
      return { ok: false, error: 'No hay un cotizador en esta demo.' };
    }
    if (ctx.planned.some((e) => e.kind === 'register_demo_request')) {
      return {
        ok: false,
        error: 'Ya se registró una consulta en este mensaje.',
      };
    }
    const missing = (Object.keys(REQUIRED) as (keyof InsuranceArgs)[]).filter(
      (f) => args[f] === null,
    );
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Faltan datos: ${missing.map((f) => REQUIRED[f]).join(', ')}.`,
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
    const { quote } = result;
    const version = quote.vehicle.versions.find(
      (v) => fold(v) === fold(args.version ?? ''),
    );
    if (!version) {
      return {
        ok: false,
        error: `"${args.version}" no es una versión del ${quote.vehicle.model} en la tabla. Versiones: ${quote.vehicle.versions.join(', ')}.`,
      };
    }
    const plan = findPlan(demo, args.plan ?? '');
    const option = quote.options.find((o) => o.plan === plan?.name);
    if (!option) {
      return {
        ok: false,
        error: `"${args.plan}" no es un plan disponible para este auto. Planes: ${quote.options.map((o) => o.plan).join(', ')}.`,
      };
    }

    const vehicle = `${quote.vehicle.make} ${quote.vehicle.model} ${version}`;
    const request: DemoRequestInput = {
      customerName: args.customerName ?? undefined,
      service: option.plan,
      details: {
        vehicle,
        year: quote.year,
        location: args.location ?? '',
        zone: quote.zone,
        gnc: quote.gnc,
        monthlyArs: option.monthlyArs,
        ...(option.deductibleArs !== null
          ? { deductibleArs: option.deductibleArs }
          : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.contactPreference
          ? { contactPreference: args.contactPreference }
          : {}),
      },
    };
    return {
      ok: true,
      effect: {
        kind: 'register_demo_request',
        scenario: 'insurance',
        request,
        handoffReason: `demo seguro: ${option.plan}, ${vehicle} ${quote.year}`,
      },
      output: {
        registered: request,
        fictitious: true,
        note: 'Consulta ficticia de demo lista para un asesor; la conversación pasa al equipo. No es una póliza ni un pago.',
      },
    };
  },
};
