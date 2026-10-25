/**
 * Provider-neutral port for the language model. The bot only talks to this
 * interface; the OpenAI adapter maps it to the Responses API.
 */

/** One item of the conversation sent to the model, oldest first. */
export type AiInputItem =
  | { kind: 'message'; role: 'user' | 'assistant'; content: string }
  /** A tool call the model made in an earlier round of the same turn. */
  | { kind: 'tool_call'; callId: string; name: string; arguments: string }
  /** Our answer to that tool call (JSON text). */
  | { kind: 'tool_result'; callId: string; output: string };

/** A function the model may call. `parameters` is a strict JSON Schema. */
export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiRequest {
  /** Model id: the business's profile model, or OPENAI_MODEL. */
  model: string;
  instructions: string;
  input: readonly AiInputItem[];
  tools: readonly AiToolDefinition[];
  maxOutputTokens: number;
}

export interface AiToolCall {
  callId: string;
  name: string;
  /** Raw JSON text produced by the model: untrusted, validate before use. */
  arguments: string;
}

export interface AiResponse {
  outputText: string;
  toolCalls: AiToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /** Model that served the request (as reported by the provider). */
  model: string;
}

/**
 * Failure of a model call. `code` is a short static label (no prompt, user
 * text or secrets); `retryable` tells whether trying again later may work.
 */
export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  /** Throws {@link AiProviderError} on failure. */
  respond(request: AiRequest): Promise<AiResponse>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
