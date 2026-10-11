/**
 * Port for sending WhatsApp messages. Inject with {@link WHATSAPP_CLIENT}.
 */
export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<SendOutcome>;
}

export const WHATSAPP_CLIENT = Symbol('WHATSAPP_CLIENT');

/**
 * - `sent`: Meta accepted the message (accepted, not necessarily delivered).
 * - `rejected`: Meta (or the network, before the request left) refused it;
 *   nothing was sent. `retryable` says whether trying again later is safe.
 * - `uncertain`: the request may have reached Meta but no verdict came back
 *   (timeout, connection drop, 5xx). Resending could duplicate the message.
 */
export type SendOutcome =
  | { kind: 'sent'; waMessageId: string }
  | {
      kind: 'rejected';
      code: number | string;
      httpStatus: number | null;
      message: string;
      retryable: boolean;
    }
  | { kind: 'uncertain'; reason: string };

/** Masks a wa_id / phone number for logs: keeps only the last 4 digits. */
export function maskPhone(value: string): string {
  return `***${value.slice(-4)}`;
}
