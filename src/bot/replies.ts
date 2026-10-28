import {
  DEMO_SCENARIOS,
  type DemoScenario,
  LEGACY_DEMO_SCENARIO,
} from '../demos/demo-scenarios.js';
import type { ReplyButton } from '../whatsapp/whatsapp.client.js';
import {
  DEMO_BUTTON,
  DEMO_SCENARIO_BUTTONS,
  EXIT_DEMO_BUTTON,
} from './reply-buttons.js';

/** Values interpolated into fixed replies. */
export interface ReplyVars {
  /** Name of the fictitious demo business, from the demo content file. */
  demoBusinessName: string;
  /** The demo being entered or reset (absent outside the demo). */
  demoScenario?: DemoScenario;
  /** How the business's bot introduces itself (AgentProfile.botName). */
  botName: string;
}

/** Fixed bot replies for deterministic commands (Spanish, voseo). */
/** How each demo introduces itself after the "you are in the demo" notice. */
const DEMO_INTROS: Record<DemoScenario, (name: string) => string[]> = {
  insurance: (name) => [
    `Ahora vas a hablar con el asistente de ejemplo de "${name}", armado para mostrarte cómo funciona el bot. Los planes y las cotizaciones son simulados: no se emiten pólizas ni se cobran pagos.`,
    'Para volver cuando quieras, tocá el botón de abajo.',
    '',
    `¡Hola! Soy el asistente de ${name} 🚗 ¿Querés asegurar un auto o comparar lo que estás pagando? Si querés, contame de una qué auto tenés, de qué año y de dónde sos.`,
  ],
  aesthetics: (name) => [
    `Ahora vas a hablar con la recepcionista virtual de "${name}", un centro de estética inventado para mostrarte cómo funciona el bot. El negocio, sus precios y todos sus datos son ficticios: no se reservan turnos ni se cobran pagos.`,
    'Para volver cuando quieras, tocá el botón de abajo.',
    '',
    `¡Hola! Soy la recepcionista virtual de ${name}. ¿En qué te puedo ayudar? Podés consultar servicios, precios, duración u horarios.`,
  ],
};

const REPLIES = {
  CHOOSE_DEMO: () =>
    '🧪 ¿Qué demo querés probar? Elegí un negocio de ejemplo con los botones y escribí como si fueras cliente.',
  ENTER_DEMO: ({ demoBusinessName, demoScenario }: ReplyVars) =>
    [
      '🧪 Entraste en modo DEMO.',
      ...DEMO_INTROS[demoScenario ?? LEGACY_DEMO_SCENARIO](demoBusinessName),
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
  RESET_DEMO: ({ demoBusinessName }: ReplyVars) =>
    `Empezamos la demo de nuevo 🔄 Seguís en "${demoBusinessName}", el negocio ficticio; tocá el botón para volver.`,
  HUMAN_REQUESTED: () =>
    'Listo, le aviso al equipo. Una persona te va a responder por acá lo antes posible. Mientras tanto, las respuestas automáticas quedan en pausa.',
} satisfies Record<string, (vars: ReplyVars) => string>;

export type ReplyKey = keyof typeof REPLIES;

export function renderReply(key: ReplyKey, vars: ReplyVars): string {
  return REPLIES[key](vars);
}

/** Buttons a fixed reply goes out with (the same commands, tappable). */
const REPLY_BUTTONS: Partial<Record<ReplyKey, ReplyButton[]>> = {
  CHOOSE_DEMO: DEMO_SCENARIOS.map((s) => DEMO_SCENARIO_BUTTONS[s]),
  ENTER_DEMO: [EXIT_DEMO_BUTTON],
  ALREADY_IN_DEMO: [EXIT_DEMO_BUTTON],
  RESET_DEMO: [EXIT_DEMO_BUTTON],
  NOT_IN_DEMO: [DEMO_BUTTON],
};

export function replyButtons(key: ReplyKey): ReplyButton[] {
  return REPLY_BUTTONS[key] ?? [];
}
