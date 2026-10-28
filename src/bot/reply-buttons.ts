import { z } from 'zod';
import type { DemoScenario } from '../demos/demo-scenarios.js';
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

/** The demo picker: one button per scenario, in DEMO_SCENARIOS order. */
export const DEMO_SCENARIO_BUTTONS: Readonly<
  Record<DemoScenario, ReplyButton>
> = {
  insurance: { id: 'demo_seguro', title: '🚗 Seguro de auto' },
  aesthetics: { id: 'demo_estetica', title: '💆 Estética' },
};

const storedSchema = z
  .array(z.object({ id: z.string(), title: z.string() }))
  .max(MAX_BUTTONS);

/** The buttons stored on a message row (Message.buttons); none if invalid. */
export function storedButtons(value: unknown): ReplyButton[] {
  const parsed = storedSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
