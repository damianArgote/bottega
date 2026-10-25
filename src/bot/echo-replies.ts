const MAX_ECHOED_CHARS = 200;

export const UNSUPPORTED_REPLY =
  'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribís?';

/** Echo reply for BOT_REPLY_MODE=echo. Truncates by code point (emoji-safe). */
export function echoReply(text: string): string {
  const chars = Array.from(text.trim());
  const echoed =
    chars.length > MAX_ECHOED_CHARS
      ? `${chars.slice(0, MAX_ECHOED_CHARS).join('')}…`
      : chars.join('');
  return `Hola! Soy BotSuite46 🤖 Recibí tu mensaje: "${echoed}"`;
}
