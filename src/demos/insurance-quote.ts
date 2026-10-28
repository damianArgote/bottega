import type { InsuranceDemo } from '../content/content.schema.js';

/** Goes with every simulated price the user sees. */
export const INSURANCE_DISCLAIMER = 'Cotización simulada para demostración';

type Vehicle = InsuranceDemo['vehicles'][number];
type Plan = InsuranceDemo['plans'][number];

/** What the quote needs, as the user said it (validated here). */
export interface QuoteRequest {
  model: string;
  year: number;
  zone: string;
  gnc: boolean;
}

export interface QuoteOption {
  plan: string;
  monthlyArs: number;
  deductibleArs: number | null;
}

export interface Quote {
  vehicle: { make: string; model: string; versions: string[] };
  zone: string;
  year: number;
  gnc: boolean;
  options: QuoteOption[];
  /** Plans left out because of the vehicle's age. */
  notAvailable: string[];
}

export type QuoteResult =
  { ok: true; quote: Quote } | { ok: false; error: string };

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Vehicle of the demo table by model ("gol trend", "VW Gol Trend"). */
export function findVehicle(demo: InsuranceDemo, name: string): Vehicle | null {
  const wanted = fold(name);
  return (
    demo.vehicles.find(
      (v) =>
        fold(v.model) === wanted || fold(`${v.make} ${v.model}`) === wanted,
    ) ?? null
  );
}

export function findPlan(demo: InsuranceDemo, name: string): Plan | null {
  const wanted = fold(name);
  return demo.plans.find((p) => fold(p.name) === wanted) ?? null;
}

export function findZone(demo: InsuranceDemo, name: string) {
  const wanted = fold(name);
  return demo.zones.find((z) => fold(z.name) === wanted) ?? null;
}

/** Rounded to hundreds, as a price list would show it. */
const roundArs = (value: number) => Math.round(value / 100) * 100;

/**
 * Simulated monthly prices from the demo table: plan price for the vehicle's
 * category × zone factor, plus the GNC surcharge. Plans that do not accept
 * a vehicle that old are left out. Errors are written for the model.
 */
export function quoteInsurance(
  demo: InsuranceDemo,
  request: QuoteRequest,
  currentYear: number,
): QuoteResult {
  const vehicle = findVehicle(demo, request.model);
  if (!vehicle) {
    return {
      ok: false,
      error: `"${request.model}" no está en la tabla de la demo. Autos que se pueden cotizar: ${demo.vehicles.map((v) => `${v.make} ${v.model}`).join(', ')}. Si tiene otro auto, ofrecé que lo cotice un asesor.`,
    };
  }
  if (
    !Number.isInteger(request.year) ||
    request.year < demo.minYear ||
    request.year > currentYear + 1
  ) {
    return {
      ok: false,
      error: `El año tiene que estar entre ${demo.minYear} y ${currentYear + 1}. Si el auto es más viejo, ofrecé que lo cotice un asesor.`,
    };
  }
  const zone = findZone(demo, request.zone);
  if (!zone) {
    return {
      ok: false,
      error: `Zona desconocida. Zonas: ${demo.zones.map((z) => z.name).join(', ')}. Si no sabés en cuál está su localidad, preguntale.`,
    };
  }

  const age = currentYear - request.year;
  const accepts = (p: Plan) =>
    p.maxVehicleAgeYears === null || age <= p.maxVehicleAgeYears;
  const factor =
    (zone.factorPercent / 100) *
    (request.gnc ? 1 + demo.gncSurchargePercent / 100 : 1);
  return {
    ok: true,
    quote: {
      vehicle: {
        make: vehicle.make,
        model: vehicle.model,
        versions: vehicle.versions,
      },
      zone: zone.name,
      year: request.year,
      gnc: request.gnc,
      options: demo.plans.filter(accepts).map((p) => ({
        plan: p.name,
        monthlyArs: roundArs(p.monthlyArs[vehicle.category] * factor),
        deductibleArs: p.deductibleArs,
      })),
      notAvailable: demo.plans.filter((p) => !accepts(p)).map((p) => p.name),
    },
  };
}
