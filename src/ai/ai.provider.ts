/**
 * Provider-neutral port for the language model. The bot only talks to this
 * interface; the OpenAI adapter maps it to the Responses API.
 */

/**
 * Content of a user message beyond plain text: an image or a PDF, as a
 * base64 data URL (`data:<type>;base64,...`). Never logged.
 */
export type AiContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'file'; filename: string; dataUrl: string };

/** One item of the conversation sent to the model, oldest first. */
export type AiInputItem =
  | { kind: 'message'; role: 'user' | 'assistant'; content: string }
  /** A user message with parts (the catalog's documents). */
  | { kind: 'parts'; content: readonly AiContentPart[] }
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
  /** 'none': the model must answer with text (the tools stay defined). */
  toolChoice?: 'none';
  maxOutputTokens: number;
  /**
   * The text answer must be JSON matching this strict JSON Schema (the
   * catalog's mapping and extraction). Still untrusted: validate it.
   */
  responseFormat?: { name: string; schema: Record<string, unknown> };
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
