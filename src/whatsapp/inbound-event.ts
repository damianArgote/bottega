/**
 * Normalized events extracted from a WhatsApp Cloud API webhook payload.
 * Produced by `parseWebhookPayload`; consumed by `ConversationsService.ingest`.
 */
/** What an attachment is (message.media_kind). */
export type MediaKind =
  'image' | 'audio' | 'document' | 'video' | 'sticker' | 'location' | 'other';

/**
 * An attachment as Meta describes it in the webhook. The file stays in Meta
 * (fetched later by `mediaId`); caption and filename are personal data.
 */
export interface InboundMedia {
  kind: MediaKind;
  mediaId?: string;
  mime?: string;
  /** Bytes, when the webhook says. */
  size?: number;
  caption?: string;
  /** Documents only. */
  filename?: string;
  /** Audio recorded as a voice note. */
  voice?: boolean;
}

export interface InboundText {
  kind: 'text';
  /** Meta phone_number_id of the business line the event belongs to. */
  phoneNumberId: string;
  waMessageId: string;
  /** Sender wa_id (phone number, digits only). Treat as personal data. */
  from: string;
  timestamp: Date;
  text: string;
  profileName?: string;
  /** Set for a location, stored as text (`Ubicación: ...`). */
  media?: InboundMedia;
}

export interface InboundUnsupported {
  kind: 'unsupported';
  phoneNumberId: string;
  waMessageId: string;
  from: string;
  timestamp: Date;
  /** Meta message type, e.g. `image`, `audio`, `sticker`, `unsupported`. */
  messageType: string;
  profileName?: string;
  /** Image, audio, document, video or sticker; absent for unknown types. */
  media?: InboundMedia;
}

export interface StatusError {
  code: number;
  title?: string;
}

export interface StatusUpdate {
  kind: 'status';
  phoneNumberId: string;
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
