import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from 'openai';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  Response as OpenAiResponse,
} from 'openai/resources/responses/responses';
import {
  AiProviderError,
  type AiInputItem,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from './ai.provider.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  timeoutMs: number;
}

/** The part of the OpenAI client this adapter uses (mockable in tests). */
export interface ResponsesClient {
  responses: {
    create(body: ResponseCreateParamsNonStreaming): Promise<OpenAiResponse>;
  };
}

/**
 * AiProvider over the OpenAI Responses API.
 *
 * - Stateless: `store: false`, and every round resends the whole input
 *   (history plus this turn's tool calls and results).
 * - `maxRetries: 0`: the job queue owns retries and their backoff.
 * - Never logs or embeds the prompt, the history, user text or the key.
 */
export class OpenAiProvider implements AiProvider {
  private readonly client: ResponsesClient;

  constructor(
    private readonly options: OpenAiProviderOptions,
    client?: ResponsesClient,
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: options.apiKey,
        timeout: options.timeoutMs,
        maxRetries: 0,
      });
  }

  async respond(request: AiRequest): Promise<AiResponse> {
    let response: OpenAiResponse;
    try {
      response = await this.client.responses.create({
        model: request.model,
        instructions: request.instructions,
        input: request.input.map(toOpenAiItem),
        tools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        })),
        max_output_tokens: request.maxOutputTokens,
        store: false,
      });
    } catch (error) {
      throw classifyOpenAiError(error);
    }

    if (response.status === 'failed' || response.status === 'cancelled') {
      throw new AiProviderError(`openai_response_${response.status}`, true);
    }
    const toolCalls = response.output.flatMap((item) =>
      item.type === 'function_call'
        ? [{ callId: item.call_id, name: item.name, arguments: item.arguments }]
        : [],
    );
    return {
      outputText: response.output_text ?? '',
      toolCalls,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      model: response.model || request.model,
    };
  }
}

/**
 * Items are rebuilt without provider ids: with `store: false` the API cannot
 * resolve references to earlier items, so only their content is resent.
 */
function toOpenAiItem(item: AiInputItem): ResponseInputItem {
  switch (item.kind) {
    case 'message':
      return { type: 'message', role: item.role, content: item.content };
    case 'tool_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    case 'tool_result':
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: item.output,
      };
  }
}

/**
 * Maps an OpenAI SDK error to a content-free {@link AiProviderError}.
 * Connection problems, timeouts, 408/409/429 and 5xx are retryable; other
 * HTTP errors (400 bad request, 401/403 credentials, 404 unknown model, ...)
 * will fail the same way again, so they are not.
 */
export function classifyOpenAiError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) {
    return error;
  }
  if (error instanceof APIConnectionError) {
    return new AiProviderError(
      error instanceof APIConnectionTimeoutError
        ? 'openai_timeout'
        : 'openai_connection',
      true,
    );
  }
  if (error instanceof APIError && typeof error.status === 'number') {
    const status = error.status;
    const retryable =
      status === 408 || status === 409 || status === 429 || status >= 500;
    return new AiProviderError(`openai_http_${status}`, retryable);
  }
  return new AiProviderError('openai_unexpected', false);
}
