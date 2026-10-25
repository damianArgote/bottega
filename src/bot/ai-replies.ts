import type { DemoRequestInput } from '../demos/demos.service.js';

/** Controlled reply when the model failed or answered nothing usable. */
export const AI_FALLBACK_REPLY =
  'Tuve un problema para responderte. Probá de nuevo en un rato o escribí *humano* para hablar con una persona del equipo.';

/** Reply when the daily AI cap of the user is reached. */
export const AI_LIMIT_REPLY =
  'Por hoy llegamos al límite de respuestas automáticas 🙏 Mañana sigo respondiéndote. Si querés hablar con una persona del equipo, escribí *humano*.';

/** Used when the model saved lead data but wrote no text. */
export const LEAD_SAVED_ACK = '¡Gracias! Ya lo anoté.';

/**
 * Backend-built confirmation of a fictitious demo request: lists exactly what
 * was registered, so it never depends on the model's wording.
 */
export function demoRequestSummary(
  request: DemoRequestInput,
  businessName: string,
): string {
  const lines = [
    request.customerName && `• Nombre: ${request.customerName}`,
    request.service && `• Servicio: ${request.service}`,
    request.preferredDate && `• Día: ${request.preferredDate}`,
    request.preferredTime && `• Horario: ${request.preferredTime}`,
    request.notes && `• Notas: ${request.notes}`,
  ].filter(Boolean);
  return [
    `📝 Solicitud de turno de demo registrada en ${businessName}:`,
    ...lines,
    '⚠️ Es una solicitud FICTICIA de la demo: no es una reserva real ni se cobró ningún pago.',
    'Escribí "salir" para volver al asistente de BotSuite46.',
  ].join('\n');
}
