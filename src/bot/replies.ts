import type { ReplyButton } from '../whatsapp/whatsapp.client.js';
import { DEMO_BUTTON, EXIT_DEMO_BUTTON } from './reply-buttons.js';

/** Values interpolated into fixed replies. */
export interface ReplyVars {
  /** Name of the fictitious demo business, from the demo content file. */
  demoBusinessName: string;
  /** How the business's bot introduces itself (AgentProfile.botName). */
  botName: string;
}

/** Fixed bot replies for deterministic commands (Spanish, voseo). */
const REPLIES = {
  ENTER_DEMO: ({ demoBusinessName }: ReplyVars) =>
    [
      '🧪 Entraste en modo DEMO.',
      `Ahora vas a hablar con el asistente de "${demoBusinessName}", una barbería inventada para mostrarte cómo funciona el bot. El negocio, sus precios y todos sus datos son ficticios: no se hacen reservas ni pagos reales.`,
      'Para volver cuando quieras, tocá el botón de abajo.',
      '',
      `¡Hola! Bienvenido a ${demoBusinessName} 💈 ¿En qué te puedo ayudar? Podés consultar servicios, precios u horarios, o pedir un turno.`,
    ].join('\n'),
  ALREADY_IN_DEMO: () =>
    'Ya estás en la demo 😉 Seguí escribiendo como si fueras cliente, o tocá el botón para volver.',
  EXIT_DEMO: ({ botName }: ReplyVars) =>
    `Saliste de la demo. Volviste a hablar con ${botName}. ¿Qué te pareció la demo?`,
  DEMO_UNAVAILABLE: () =>
    'Por acá no hay una demo para probar. ¿En qué te puedo ayudar?',
  NOT_IN_DEMO: () =>
    'No estás en ninguna demo 🙂 Si querés probar una, tocá el botón.',
  RESET_COMMERCIAL: () =>
    'Empezamos de nuevo. Arrancamos la charla desde cero (lo que ya nos contaste sigue guardado para el equipo). ¿En qué te puedo ayudar?',
  RESET_DEMO: () =>
    'Empezamos la demo de nuevo 🔄 Seguís en la barbería ficticia; tocá el botón para volver.',
  HUMAN_REQUESTED: () =>
    'Listo, le aviso al equipo. Una persona te va a responder por acá lo antes posible. Mientras tanto, las respuestas automáticas quedan en pausa.',
} satisfies Record<string, (vars: ReplyVars) => string>;

export type ReplyKey = keyof typeof REPLIES;

export function renderReply(key: ReplyKey, vars: ReplyVars): string {
  return REPLIES[key](vars);
}

/** Buttons a fixed reply goes out with (the same commands, tappable). */
const REPLY_BUTTONS: Partial<Record<ReplyKey, ReplyButton[]>> = {
  ENTER_DEMO: [EXIT_DEMO_BUTTON],
  ALREADY_IN_DEMO: [EXIT_DEMO_BUTTON],
  RESET_DEMO: [EXIT_DEMO_BUTTON],
  NOT_IN_DEMO: [DEMO_BUTTON],
};

export function replyButtons(key: ReplyKey): ReplyButton[] {
  return REPLY_BUTTONS[key] ?? [];
}
