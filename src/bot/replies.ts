/** Values interpolated into fixed replies. */
export interface ReplyVars {
  /** Name of the fictitious demo business, from the demo content file. */
  demoBusinessName: string;
}

/** Fixed bot replies for deterministic commands (Spanish, voseo). */
const REPLIES = {
  ENTER_DEMO: ({ demoBusinessName }: ReplyVars) =>
    [
      '🧪 Entraste en modo DEMO.',
      `Ahora vas a hablar con el asistente de "${demoBusinessName}", una barbería inventada para mostrarte cómo funciona el bot. El negocio, sus precios y todos sus datos son ficticios: no se hacen reservas ni pagos reales.`,
      'Para volver cuando quieras, escribí "salir".',
      '',
      `¡Hola! Bienvenido a ${demoBusinessName} 💈 ¿En qué te puedo ayudar? Podés consultar servicios, precios u horarios, o pedir un turno.`,
    ].join('\n'),
  ALREADY_IN_DEMO: () =>
    'Ya estás en la demo 😉 Seguí escribiendo como si fueras cliente, o escribí "salir" para volver.',
  EXIT_DEMO: () =>
    'Saliste de la demo. Volviste a hablar con el asistente de Bottega 👋 ¿Querés contarme qué necesitás para tu negocio?',
  NOT_IN_DEMO: () =>
    'No estás en ninguna demo. Si querés probar una, escribí "demo".',
  RESET_COMMERCIAL: () =>
    'Empezamos de nuevo 🔄 Arrancamos la charla desde cero (lo que ya nos contaste sigue guardado para el equipo). ¿En qué te puedo ayudar?',
  RESET_DEMO: () =>
    'Empezamos la demo de nuevo 🔄 Seguís en la barbería ficticia; escribí "salir" para volver.',
  HUMAN_REQUESTED: () =>
    'Listo, le aviso al equipo de Bottega. Una persona te va a responder por acá lo antes posible. Mientras tanto, el asistente automático queda en pausa.',
} satisfies Record<string, (vars: ReplyVars) => string>;

export type ReplyKey = keyof typeof REPLIES;

export function renderReply(key: ReplyKey, vars: ReplyVars): string {
  return REPLIES[key](vars);
}
