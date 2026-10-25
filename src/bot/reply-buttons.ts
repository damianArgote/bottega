import { z } from 'zod';
import type { ReplyButton } from '../whatsapp/whatsapp.client.js';

/** WhatsApp's limit for a reply button title. */
export const MAX_BUTTON_TITLE = 20;
/** WhatsApp allows at most 3 reply buttons per message. */
export const MAX_BUTTONS = 3;

/**
 * The titles are also commands (commands.ts): tapping a button sends its
 * title as the user's text.
 */
export const DEMO_BUTTON: ReplyButton = {
  id: 'demo',
  title: '🧪 Probar la demo',
};
export const EXIT_DEMO_BUTTON: ReplyButton = {
  id: 'salir',
  title: '👋 Salir de la demo',
};

/**
 * Buttons for a reply that invites to write a command: `"demo"` gets
 * "Probar la demo" and `"salir"` gets "Salir de la demo". Used for the
 * fixed replies and as a default for the model's text.
 */
export function textButtons(text: string): ReplyButton[] {
  return [
    ...(text.includes('"demo"') ? [DEMO_BUTTON] : []),
    ...(text.includes('"salir"') ? [EXIT_DEMO_BUTTON] : []),
  ];
}

const storedSchema = z
  .array(z.object({ id: z.string(), title: z.string() }))
  .max(MAX_BUTTONS);

/** The buttons stored on a message row (Message.buttons); none if invalid. */
export function storedButtons(value: unknown): ReplyButton[] {
  const parsed = storedSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
