/**
 * Normalized events extracted from a WhatsApp Cloud API webhook payload.
 * Produced by `parseWebhookPayload`; consumed by `ConversationsService.ingest`.
 */
export interface InboundText {
  kind: 'text';
  waMessageId: string;
  /** Sender wa_id (phone number, digits only). Treat as personal data. */
  from: string;
  timestamp: Date;
  text: string;
  profileName?: string;
}

export interface InboundUnsupported {
  kind: 'unsupported';
  waMessageId: string;
  from: string;
  timestamp: Date;
  /** Meta message type, e.g. `image`, `audio`, `location`, `unsupported`. */
  messageType: string;
}

export interface StatusError {
  code: number;
  title?: string;
}

export interface StatusUpdate {
  kind: 'status';
  /** wamid of the outbound message this status refers to. */
  waMessageId: string;
  status: string;
  recipientId: string;
  timestamp: Date;
  errors?: StatusError[];
}

export interface Ignored {
  kind: 'ignored';
  /** Static, non-sensitive reason. Never contains payload content. */
  reason: string;
}

export type InboundEvent =
  InboundText | InboundUnsupported | StatusUpdate | Ignored;
