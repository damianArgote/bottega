import { z } from 'zod';
import type {
  Ignored,
  InboundEvent,
  StatusError,
  StatusUpdate,
} from './inbound-event.js';

export interface ParserOptions {
  /** Only events addressed to this phone number id are processed. */
  phoneNumberId: string;
}

/**
 * Message types that never get a reply:
 * - `reaction`: answering an emoji reaction with "text only" would be noise.
 * - `system`: notifications such as "customer changed number", not user input.
 * Every other non-text type (image, audio, sticker, location, Meta's own
 * `unsupported`, ...) becomes `InboundUnsupported` so the user gets a hint.
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

const messageSchema = z.object({
  from: z.string().min(1),
  id: z.string().min(1),
  timestamp: unixSeconds,
  type: z.string().min(1),
  text: z.object({ body: z.string() }).optional(),
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
 * Turns a raw webhook payload into normalized events.
 *
 * Pure and total: it never throws. Every malformed or out-of-scope item is
 * reported as `Ignored` (with a static reason) and the rest of the batch is
 * still processed.
 */
export function parseWebhookPayload(
  payload: unknown,
  options: ParserOptions,
): InboundEvent[] {
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
      events.push(...parseChange(rawChange, options));
    }
  }
  return events;
}

function parseChange(
  rawChange: unknown,
  options: ParserOptions,
): InboundEvent[] {
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
  if (metadata.phone_number_id !== options.phoneNumberId) {
    return [ignored('event for another phone number id')];
  }

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
    events.push(parseMessage(rawMessage, businessNumber, profileNames));
  }
  for (const rawStatus of statuses) {
    events.push(parseStatus(rawStatus));
  }
  return events;
}

function parseMessage(
  rawMessage: unknown,
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

  const base = {
    waMessageId: message.id,
    from: message.from,
    timestamp: toDate(message.timestamp),
  };
  if (message.type !== 'text') {
    return { kind: 'unsupported', ...base, messageType: message.type };
  }
  if (!message.text) {
    return ignored('text message without body');
  }
  const profileName = profileNames.get(message.from);
  return {
    kind: 'text',
    ...base,
    text: message.text.body,
    ...(profileName !== undefined ? { profileName } : {}),
  };
}

function parseStatus(rawStatus: unknown): InboundEvent {
  const parsed = statusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    return ignored('malformed status');
  }
  const status = parsed.data;
  const event: StatusUpdate = {
    kind: 'status',
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
