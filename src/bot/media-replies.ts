/**
 * Fixed replies about attachments (prompt 11). The bot always answers in
 * text; none of these hands the conversation to a person.
 */

/** Anything the bot cannot open (video, sticker, Word, other audio...). */
export const MEDIA_UNSUPPORTED_REPLY =
  'Todavía no puedo abrir ese tipo de archivo. ¿Me contás por escrito qué necesitás?';

export const AUDIO_FAILED_REPLY =
  'No pude escuchar bien el audio. ¿Me lo escribís o me mandás otro?';

export const AUDIO_TOO_LARGE_REPLY =
  'Ese audio es muy pesado para mí. ¿Me mandás uno más corto o me lo escribís?';

export const FILE_TOO_LARGE_REPLY =
  'El archivo es muy pesado para abrirlo. ¿Me contás por escrito qué necesitás?';

export const MEDIA_DAILY_CAP_REPLY =
  'Por hoy no puedo abrir más archivos en esta charla. ¿Me lo escribís?';

export const MEDIA_GONE_REPLY =
  'No pude abrir el archivo. ¿Me lo mandás de nuevo?';

/** The file could not be fetched for a reason on our side: no resend. */
export const MEDIA_UNAVAILABLE_REPLY =
  'No pude abrir el archivo en este momento. ¿Me contás por escrito qué necesitás?';

/** "Ese audio es muy largo para mí (hasta 2 minutos)...". */
export function audioTooLongReply(maxSeconds: number): string {
  return `Ese audio es muy largo para mí (hasta ${durationText(maxSeconds)}). ¿Me mandás uno más corto o me lo escribís?`;
}

/** 60 → "1 minuto", 90 → "1 minuto y medio", 120 → "2 minutos", 45 → "45 segundos". */
export function durationText(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
  }
  if (seconds % 60 === 30 && seconds > 60) {
    const minutes = (seconds - 30) / 60;
    return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} y medio`;
  }
  return `${seconds} segundos`;
}
