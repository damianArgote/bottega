import { z } from 'zod';
import type {
  Ignored,
  InboundEvent,
  StatusError,
  StatusUpdate,
} from './inbound-event.js';

/**
 * Message types that never get a reply:
 * - `reaction`: answering an emoji reaction with "text only" would be noise.
 * - `system`: notifications such as "customer changed number", not user input.
 * Image, audio, document, video and sticker become `InboundUnsupported`
 * with their media; a location becomes text; any other type (Meta's own
 * `unsupported`, ...) becomes `InboundUnsupported` without media.
 */
const IGNORED_MESSAGE_TYPES = new Set(['reaction', 'system']);

const unixSeconds = z.string().regex(/^\d+$/);

const entrySchema = z.object({
  changes: z.array(z.unknown()),
});

const changeSchema = z.object({
  field: z.string(),
  value: z.unknown(),
});

const valueSchema = z.object({
  metadata: z.object({
    display_phone_number: z.string(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const contactSchema = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string() }).optional(),
});

/** The fields of an image, audio, document, video or sticker object. */
const mediaObject = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  file_size: z.number().int().nonnegative().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

const locationObject = z.object({
  latitude: z.number(),
  longitude: z.number(),
  name: z.string().optional(),
  address: z.string().optional(),
});

const MEDIA_TYPES = ['image', 'audio', 'document', 'video', 'sticker'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
const isMediaType = (type: string): type is MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(type);

const messageSchema = z.object({
  from: z.string().min(1),
  id: z.string().min(1),
  timestamp: unixSeconds,
  type: z.string().min(1),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ title: z.string() }).optional(),
      list_reply: z.object({ title: z.string() }).optional(),
    })
    .optional(),
  image: mediaObject.optional(),
  audio: mediaObject.optional(),
  document: mediaObject.optional(),
  video: mediaObject.optional(),
  sticker: mediaObject.optional(),
  location: locationObject.optional(),
});

const statusSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: unixSeconds,
  recipient_id: z.string().min(1),
  errors: z
    .array(z.object({ code: z.number(), title: z.string().optional() }))
    .optional(),
});

const ignored = (reason: string): Ignored => ({ kind: 'ignored', reason });

const toDate = (seconds: string): Date => new Date(Number(seconds) * 1000);

const digitsOnly = (value: string): string => value.replace(/\D/g, '');

/**
 * Turns a raw webhook payload into normalized events. Message and status
 * events carry the `phone_number_id` of their change; routing them to a
 * line (and rejecting other lines) is the caller's job.
 *
 * Pure and total: it never throws. Every malformed or out-of-scope item is
 * reported as `Ignored` (with a static reason) and the rest of the batch is
 * still processed.
 */
export function parseWebhookPayload(payload: unknown): InboundEvent[] {
  const root = z
    .object({ object: z.string(), entry: z.array(z.unknown()) })
    .safeParse(payload);
  if (!root.success) {
    return [ignored('malformed payload')];
  }
  if (root.data.object !== 'whatsapp_business_account') {
    return [ignored('unexpected object type')];
  }

  const events: InboundEvent[] = [];
  for (const rawEntry of root.data.entry) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      events.push(ignored('malformed entry'));
      continue;
    }
    for (const rawChange of entry.data.changes) {
      events.push(...parseChange(rawChange));
    }
  }
  return events;
}

function parseChange(rawChange: unknown): InboundEvent[] {
  const change = changeSchema.safeParse(rawChange);
  if (!change.success) {
    return [ignored('malformed change')];
  }
  if (change.data.field !== 'messages') {
    return [ignored('unsupported change field')];
  }
  const value = valueSchema.safeParse(change.data.value);
  if (!value.success) {
    return [ignored('malformed change value')];
  }
  const { metadata, contacts = [], messages = [], statuses = [] } = value.data;
  const phoneNumberId = metadata.phone_number_id;

  const profileNames = new Map<string, string>();
  for (const rawContact of contacts) {
    const contact = contactSchema.safeParse(rawContact);
    if (contact.success && contact.data.profile) {
      profileNames.set(contact.data.wa_id, contact.data.profile.name);
    }
  }

  const businessNumber = digitsOnly(metadata.display_phone_number);
  const events: InboundEvent[] = [];
  for (const rawMessage of messages) {
    events.push(
      parseMessage(rawMessage, phoneNumberId, businessNumber, profileNames),
    );
  }
  for (const rawStatus of statuses) {
    events.push(parseStatus(rawStatus, phoneNumberId));
  }
  return events;
}

function parseMessage(
  rawMessage: unknown,
  phoneNumberId: string,
  businessNumber: string,
  profileNames: Map<string, string>,
): InboundEvent {
  const parsed = messageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return ignored('malformed message');
  }
  const message = parsed.data;
  if (businessNumber && digitsOnly(message.from) === businessNumber) {
    return ignored('message from the business number');
  }
  if (IGNORED_MESSAGE_TYPES.has(message.type)) {
    return ignored(`ignored message type`);
  }

  const profileName = profileNames.get(message.from);
  const base = {
    phoneNumberId,
    waMessageId: message.id,
    from: message.from,
    timestamp: toDate(message.timestamp),
    ...(profileName !== undefined ? { profileName } : {}),
  };
  if (message.type === 'location' && message.location) {
    return {
      kind: 'text',
      ...base,
      text: locationText(message.location),
      media: { kind: 'location' },
    };
  }
  const media = isMediaType(message.type) ? message[message.type] : undefined;
  if (media) {
    return {
      kind: 'unsupported',
      ...base,
      messageType: message.type,
      media: {
        kind: message.type as MediaType,
        mediaId: media.id,
        ...(media.mime_type ? { mime: media.mime_type } : {}),
        ...(media.file_size !== undefined ? { size: media.file_size } : {}),
        ...(media.caption?.trim() ? { caption: media.caption.trim() } : {}),
        ...(media.filename ? { filename: media.filename } : {}),
        ...(media.voice !== undefined ? { voice: media.voice } : {}),
      },
    };
  }
  // A tapped reply button or list option arrives as its title, like text.
  const tapped =
    message.type === 'interactive'
      ? (message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title)
      : undefined;
  if (message.type !== 'text' && tapped === undefined) {
    return { kind: 'unsupported', ...base, messageType: message.type };
  }
  const body = tapped ?? message.text?.body;
  if (body === undefined) {
    return ignored('text message without body');
  }
  return { kind: 'text', ...base, text: body };
}

/** "Ubicación: <nombre>, <dirección> (lat, long)", for the bot and the inbox. */
function locationText(location: z.infer<typeof locationObject>): string {
  const place = [location.name, location.address]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
  const coordinates = `(${location.latitude}, ${location.longitude})`;
  return place
    ? `Ubicación: ${place} ${coordinates}`
    : `Ubicación: ${coordinates}`;
}

function parseStatus(rawStatus: unknown, phoneNumberId: string): InboundEvent {
  const parsed = statusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    return ignored('malformed status');
  }
  const status = parsed.data;
  const event: StatusUpdate = {
    kind: 'status',
    phoneNumberId,
    waMessageId: status.id,
    status: status.status,
    recipientId: status.recipient_id,
    timestamp: toDate(status.timestamp),
  };
  if (status.errors?.length) {
    event.errors = status.errors.map((error): StatusError => ({
      code: error.code,
      ...(error.title !== undefined ? { title: error.title } : {}),
    }));
  }
  return event;
}
