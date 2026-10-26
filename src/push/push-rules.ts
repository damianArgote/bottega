import type {
  ConversationStatus,
  MessageType,
  PushReason,
} from '../generated/prisma/client.js';

/** A person of the business; `active`: membership and account enabled. */
export interface PushMember {
  userId: string;
  active: boolean;
}

export interface RecipientsInput {
  reason: PushReason;
  conversation: {
    status: ConversationStatus;
    assignedToId: string | null;
    paused: boolean;
  };
  /** Everyone with a membership in the conversation's business. */
  members: readonly PushMember[];
}

/**
 * Who gets the push, with the conversation's state when the job runs:
 * - inbound message: the assignee if it has one; everyone active if nobody
 *   attends it and it waits for a person (PENDING) or the bot is paused
 *   (released); nobody while the bot attends it.
 * - handoff: everyone active.
 * Inactive people and non-members never get it.
 */
export function pushRecipients({
  reason,
  conversation,
  members,
}: RecipientsInput): string[] {
  const active = members.filter((m) => m.active).map((m) => m.userId);
  if (reason === 'HANDOFF') {
    return active;
  }
  if (conversation.assignedToId) {
    return active.filter((id) => id === conversation.assignedToId);
  }
  return conversation.status === 'PENDING' || conversation.paused ? active : [];
}

export const PUSH_BODY_MAX_LENGTH = 100;

/** What `[type]` (a non-text message) shows as. */
const MEDIA_LABELS: Readonly<Record<string, string>> = {
  audio: 'Audio',
  image: 'Imagen',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  location: 'Ubicación',
  contacts: 'Contacto',
};

export interface PayloadInput {
  reason: PushReason;
  businessId: string;
  conversationId: string;
  contact: { name: string | null; profileName: string | null; waId: string };
  /** The message to show (a handoff's latest inbound one); null: none. */
  message: { type: MessageType; content: string } | null;
}

function bodyOf(message: PayloadInput['message']): string {
  if (!message) {
    return '';
  }
  if (message.type !== 'TEXT') {
    const type = /^\[(\w+)\]$/.exec(message.content)?.[1] ?? '';
    return MEDIA_LABELS[type] ?? 'Mensaje';
  }
  // By code points, so an emoji is never cut in half.
  const chars = Array.from(message.content.trim());
  return chars.length > PUSH_BODY_MAX_LENGTH
    ? `${chars.slice(0, PUSH_BODY_MAX_LENGTH - 1).join('')}…`
    : chars.join('');
}

/**
 * The push as the inbox's Angular service worker shows it: a notification
 * per conversation (`tag`: a new one replaces the previous), opening the
 * conversation on click.
 */
export function buildPushPayload(input: PayloadInput) {
  const { contact, conversationId, businessId } = input;
  const name = contact.name || contact.profileName || `+${contact.waId}`;
  return {
    notification: {
      title:
        input.reason === 'HANDOFF'
          ? `${name} quiere hablar con una persona`
          : name,
      body: bodyOf(input.message),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: conversationId,
      renotify: true,
      data: {
        onActionClick: {
          default: {
            operation: 'navigateLastFocusedOrOpen',
            url: `/b/${businessId}/inbox/${conversationId}`,
          },
        },
      },
    },
  };
}
