import type { Message } from '../generated/prisma/client.js';

/**
 * The caption of an attachment row: its content, unless it is the
 * `[image]`-style placeholder stored when there was none.
 */
export function captionOf(
  message: Pick<Message, 'content' | 'mediaKind'>,
): string | null {
  const content = message.content.trim();
  return !content || content === `[${message.mediaKind}]` ? null : content;
}

/** True for `application/pdf` (parameters ignored). */
export function isPdfMime(mime: string | null): boolean {
  return (mime ?? '').split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}
