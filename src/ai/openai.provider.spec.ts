import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from 'openai';
import type {
  Response as OpenAiResponse,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import { AiProviderError } from './ai.provider.js';
import {
  classifyOpenAiError,
  OpenAiProvider,
  type ResponsesClient,
} from './openai.provider.js';

const httpError = (status: number) =>
  APIError.generate(status, undefined, 'boom', new Headers());

describe('classifyOpenAiError', () => {
  it.each([408, 409, 429, 500, 502, 503])('%i is retryable', (status) => {
    expect(classifyOpenAiError(httpError(status))).toMatchObject({
      code: `openai_http_${status}`,
      retryable: true,
    });
  });

  it.each([400, 401, 403, 404, 422])('%i is not retryable', (status) => {
    expect(classifyOpenAiError(httpError(status))).toMatchObject({
      code: `openai_http_${status}`,
      retryable: false,
    });
  });

  it('treats timeouts and connection failures as retryable', () => {
    expect(classifyOpenAiError(new APIConnectionTimeoutError())).toMatchObject({
      code: 'openai_timeout',
      retryable: true,
    });
    expect(
      classifyOpenAiError(new APIConnectionError({ message: 'reset' })),
    ).toMatchObject({ code: 'openai_connection', retryable: true });
  });

  it('does not retry unknown errors', () => {
    expect(classifyOpenAiError(new TypeError('x'))).toMatchObject({
      code: 'openai_unexpected',
      retryable: false,
    });
  });
});

describe('OpenAiProvider', () => {
  const options = { apiKey: 'sk-test', timeoutMs: 1 };

  const fakeClient = (result: Partial<OpenAiResponse> | Error) => {
    const create = vi.fn<
      (body: ResponseCreateParamsNonStreaming) => Promise<OpenAiResponse>
    >(() =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result as OpenAiResponse),
    );
    const client: ResponsesClient = { responses: { create } };
    return { client, create };
  };

  const request = {
    model: 'model-from-profile',
    instructions: 'Sos un asistente.',
    input: [
      { kind: 'message' as const, role: 'user' as const, content: 'hola' },
      {
        kind: 'tool_call' as const,
        callId: 'c1',
        name: 'save_lead',
        arguments: '{}',
      },
      { kind: 'tool_result' as const, callId: 'c1', output: '{"ok":true}' },
    ],
    tools: [
      { name: 'save_lead', description: 'd', parameters: { type: 'object' } },
    ],
    maxOutputTokens: 300,
  };

  it("sends a stateless, strict-tools request with the request's model", async () => {
    const { client, create } = fakeClient({
      status: 'completed',
      model: 'resolved-model',
      output: [],
      output_text: 'Hola!',
      usage: {
        input_tokens: 10,
        output_tokens: 3,
      } as OpenAiResponse['usage'],
    });

    const response = await new OpenAiProvider(options, client).respond(request);

    expect(create).toHaveBeenCalledWith({
      model: 'model-from-profile',
      instructions: 'Sos un asistente.',
      input: [
        { type: 'message', role: 'user', content: 'hola' },
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'save_lead',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
      ],
      tools: [
        {
          type: 'function',
          name: 'save_lead',
          description: 'd',
          parameters: { type: 'object' },
          strict: true,
        },
      ],
      max_output_tokens: 300,
      store: false,
    });
    expect(response).toEqual({
      outputText: 'Hola!',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 3 },
      model: 'resolved-model',
    });
  });

  it("sends tool_choice 'none' only when asked (the model must answer)", async () => {
    const { client, create } = fakeClient({
      status: 'completed',
      model: 'm',
      output: [],
      output_text: 'Listo.',
      usage: { input_tokens: 1, output_tokens: 1 } as OpenAiResponse['usage'],
    });

    await new OpenAiProvider(options, client).respond({
      ...request,
      toolChoice: 'none',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: 'none',
        tools: expect.any(Array) as unknown,
      }),
    );
  });

  it('sends images and PDFs as input parts and asks for strict JSON when given a format', async () => {
    const { client, create } = fakeClient({
      status: 'completed',
      model: 'm',
      output: [],
      output_text: '{"rows":[]}',
      usage: { input_tokens: 1, output_tokens: 1 } as OpenAiResponse['usage'],
    });
    const schema = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };

    await new OpenAiProvider(options, client).respond({
      model: 'm',
      instructions: 'Extraé.',
      input: [
        {
          kind: 'parts',
          content: [
            { kind: 'text', text: 'Lista de precios' },
            { kind: 'image', dataUrl: 'data:image/png;base64,AAA' },
            {
              kind: 'file',
              filename: 'lista.pdf',
              dataUrl: 'data:application/pdf;base64,BBB',
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 100,
      responseFormat: { name: 'catalog_rows', schema },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Lista de precios' },
              {
                type: 'input_image',
                detail: 'auto',
                image_url: 'data:image/png;base64,AAA',
              },
              {
                type: 'input_file',
                filename: 'lista.pdf',
                file_data: 'data:application/pdf;base64,BBB',
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'catalog_rows',
            schema,
            strict: true,
          },
        },
      }),
    );
  });

  it('extracts function calls from the output items', async () => {
    const { client } = fakeClient({
      status: 'completed',
      model: 'm',
      output_text: '',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_9',
          name: 'request_handoff',
          arguments: '{"reason":null}',
        },
      ] as OpenAiResponse['output'],
    });

    const response = await new OpenAiProvider(options, client).respond(request);

    expect(response.toolCalls).toEqual([
      {
        callId: 'call_9',
        name: 'request_handoff',
        arguments: '{"reason":null}',
      },
    ]);
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws classified errors without leaking the request', async () => {
    const { client } = fakeClient(httpError(429));
    const error = await new OpenAiProvider(options, client)
      .respond(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ code: 'openai_http_429', retryable: true });
    expect(String((error as Error).message)).not.toContain('hola');
  });

  it('treats a failed response as a retryable error', async () => {
    const { client } = fakeClient({ status: 'failed', output: [] });
    await expect(
      new OpenAiProvider(options, client).respond(request),
    ).rejects.toMatchObject({
      code: 'openai_response_failed',
      retryable: true,
    });
  });
});
