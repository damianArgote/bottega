/** A WhatsApp reply button: tapping it sends its title back as text. */
export interface ReplyButton {
  id: string;
  /** At most 20 characters. */
  title: string;
}

export interface SendOptions {
  /** Up to 3 reply buttons under the text (sent as an interactive message). */
  buttons?: readonly ReplyButton[];
}

/** Sends WhatsApp messages from one line. Never throws. */
export interface WhatsAppClient {
  sendText(
    to: string,
    body: string,
    options?: SendOptions,
  ): Promise<SendOutcome>;
  /**
   * Marks an inbound message as read (best effort: false on any failure).
   * Optional: clients that cannot send (or test doubles) leave it out.
   */
  markRead?(waMessageId: string): Promise<boolean>;
}

/**
 * Port that builds the client of a conversation's line, with that line's own
 * credentials. Inject with {@link WHATSAPP_CLIENT_FACTORY}.
 */
export interface WhatsAppClientFactory {
  /** Never throws: a line that cannot send gets a client that rejects. */
  forLine(lineId: string | null): Promise<WhatsAppClient>;
}

export const WHATSAPP_CLIENT_FACTORY = Symbol('WHATSAPP_CLIENT_FACTORY');

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
