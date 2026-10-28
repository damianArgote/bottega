import type { DemoRequestInput } from '../demos/demos.service.js';
import { INSURANCE_DISCLAIMER } from '../demos/insurance-quote.js';

/** Controlled reply when the model failed or answered nothing usable. */
export const AI_FALLBACK_REPLY =
  'Tuve un problema para responderte. Probá de nuevo en un rato o escribí *humano* para hablar con una persona del equipo.';

/** Reply when the daily AI cap of the user is reached. */
export const AI_LIMIT_REPLY =
  'Por hoy llegamos al límite de respuestas automáticas. Mañana sigo respondiéndote. Si querés hablar con una persona del equipo, escribí *humano*.';

/** Used when the model saved lead data but wrote no text. */
export const LEAD_SAVED_ACK = '¡Gracias! Ya lo anoté.';

const arsFormat = new Intl.NumberFormat('es-AR');

/**
 * Backend-built brief of the insurance demo's close: what the advisor needs,
 * from the stored request (the price comes from the demo table).
 */
export function insuranceRequestSummary(
  request: DemoRequestInput,
  businessName: string,
): string {
  const d = request.details ?? {};
  const ars = (value: unknown) =>
    typeof value === 'number' ? `$ ${arsFormat.format(value)}` : null;
  const gnc = d.gnc === true ? ', con GNC' : d.gnc === false ? ', sin GNC' : '';
  const lines = [
    request.customerName && `• Nombre: ${request.customerName}`,
    d.vehicle &&
      `• Auto: ${[d.vehicle, d.year].filter((v) => v !== undefined).join(' ')}${gnc}`,
    d.location && `• Localidad: ${d.location}${d.zone ? ` (${d.zone})` : ''}`,
    d.priority && `• Busca: ${d.priority}`,
    request.service &&
      `• Plan elegido: ${request.service}${ars(d.monthlyArs) ? ` – ${ars(d.monthlyArs)} por mes` : ''}`,
    ars(d.deductibleArs) && `• Franquicia: ${ars(d.deductibleArs)}`,
    d.contactPreference && `• Contacto: ${d.contactPreference}`,
  ].filter(Boolean);
  return [
    `📝 Consulta lista para un asesor de ${businessName}:`,
    ...lines,
    `⚠️ ${INSURANCE_DISCLAIMER}: no es una póliza ni un precio real.`,
  ].join('\n');
}
