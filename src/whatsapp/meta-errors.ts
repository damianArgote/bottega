/**
 * What a Meta (Graph) error code means for us, in one place:
 * - window_closed (131047): the 24 h customer service window is closed;
 *   the inbox moves the conversation's window to now.
 * - undeliverable (131026): the number cannot receive the message.
 * - rate_limited: not accepted now, try later (4 app rate limit, 80007 WABA
 *   rate limit, 130429 throughput, 131056 pair rate, 131048 spam rate
 *   limit, 131049 ecosystem limit).
 * Timeouts and 5xx never get here: the client reports them as uncertain
 * (never retried).
 */
export type MetaErrorKind =
  'window_closed' | 'undeliverable' | 'rate_limited' | 'other';

const KINDS = new Map<number, MetaErrorKind>([
  [131047, 'window_closed'],
  [131026, 'undeliverable'],
  ...[4, 80007, 130429, 131056, 131048, 131049].map(
    (code) => [code, 'rate_limited'] as const,
  ),
]);

export function metaErrorKind(code: number | string): MetaErrorKind {
  return (typeof code === 'number' && KINDS.get(code)) || 'other';
}

/**
 * Text for the user (Rioplatense Spanish) for a Graph error while onboarding
 * a line: checking credentials, registering a number or subscribing the app.
 */
export function onboardingErrorMessage(error: {
  code: number | string;
  subcode: number | null;
}): string {
  if (error.code === 133005 || error.subcode === 2388023) {
    return 'El PIN no coincide con el que tiene el número.';
  }
  switch (error.code) {
    case 190:
      return 'El token no es válido o venció. Generá uno nuevo desde el usuario del sistema.';
    case 200:
    case 10:
      return 'El token no tiene permiso sobre esta cuenta. Revisá que el usuario del sistema tenga asignadas la app y la cuenta de WhatsApp con control total.';
    case 100:
      return 'Algún ID está mal o no corresponde a esta cuenta. Revisá el WABA ID y el Phone Number ID.';
    case 133006:
      return 'El número todavía no está verificado. Primero hay que verificarlo con el código SMS en WhatsApp Manager.';
    case 133016:
      return 'Demasiados intentos de registro. Esperá antes de volver a probar.';
    case 'network_error':
      return 'No pudimos conectar con Meta. Probá de nuevo en unos minutos.';
    default:
      return `Meta rechazó el pedido (código ${error.code}).`;
  }
}
