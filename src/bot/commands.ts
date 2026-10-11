/**
 * Deterministic user commands. They are only recognized from the user's own
 * text (exact match after normalization), never inferred from model output.
 */
export const CommandId = {
  ENTER_DEMO: 'ENTER_DEMO',
  EXIT_DEMO: 'EXIT_DEMO',
  RESET: 'RESET',
  REQUEST_HUMAN: 'REQUEST_HUMAN',
} as const;

export type CommandId = (typeof CommandId)[keyof typeof CommandId];

/** Accepted phrases, already normalized (see {@link normalizeCommandText}). */
const COMMANDS: ReadonlyMap<string, CommandId> = new Map([
  ['demo', CommandId.ENTER_DEMO],
  ['probar demo', CommandId.ENTER_DEMO],
  ['salir', CommandId.EXIT_DEMO],
  ['salir de la demo', CommandId.EXIT_DEMO],
  ['reiniciar', CommandId.RESET],
  ['humano', CommandId.REQUEST_HUMAN],
  ['hablar con una persona', CommandId.REQUEST_HUMAN],
]);

/**
 * Lowercases, strips diacritics, trims punctuation/emoji around the text and
 * collapses inner whitespace: " ¡Salir! 👋 " → "salir".
 */
export function normalizeCommandText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/** The command the whole message stands for, or null for any other text. */
export function matchCommand(text: string): CommandId | null {
  return COMMANDS.get(normalizeCommandText(text)) ?? null;
}
