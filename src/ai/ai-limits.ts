/** Model calls allowed for one inbound message (tool rounds included). */
export const AI_MAX_MODEL_ROUNDS = 3;

/** Outbound replies the AI pipeline may produce for one inbound message. */
export const AI_MAX_REPLIES_PER_MESSAGE = 1;

/** Time reserved for database work in a job, on top of network timeouts. */
export const JOB_OVERHEAD_MS = 10_000;

/**
 * Worst-case duration of one AI job: every model round hitting its timeout,
 * then every reply send hitting its timeout, plus database overhead. The
 * queue lease must exceed it, or a slow job could be claimed twice.
 */
export function worstCaseAiJobMs(env: {
  OPENAI_TIMEOUT_MS: number;
  WHATSAPP_HTTP_TIMEOUT_MS: number;
}): number {
  return (
    AI_MAX_MODEL_ROUNDS * env.OPENAI_TIMEOUT_MS +
    AI_MAX_REPLIES_PER_MESSAGE * env.WHATSAPP_HTTP_TIMEOUT_MS +
    JOB_OVERHEAD_MS
  );
}
