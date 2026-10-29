import { APIError } from 'openai';
import { AiProviderError } from './ai.provider.js';
import {
  isTranscribable,
  OpenAiTranscriber,
  type TranscriptionsClient,
} from './transcriber.js';

const options = {
  apiKey: 'sk-test',
  model: 'transcribe-model',
  timeoutMs: 1000,
};

describe('OpenAiTranscriber', () => {
  const fakeClient = (result: { text: string } | Error) => {
    const create = vi.fn<
      TranscriptionsClient['audio']['transcriptions']['create']
    >(() =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
    );
    return { client: { audio: { transcriptions: { create } } }, create };
  };

  it('transcribes a voice note in Spanish with the configured model', async () => {
    const { client, create } = fakeClient({ text: '  hola, quiero un kilo  ' });

    const result = await new OpenAiTranscriber(options, client).transcribe({
      audio: Buffer.from('ogg-bytes'),
      mimeType: 'audio/ogg; codecs=opus',
    });

    expect(result).toEqual({
      text: 'hola, quiero un kilo',
      model: 'transcribe-model',
    });
    const body = create.mock.calls[0]![0];
    expect(body).toMatchObject({ model: 'transcribe-model', language: 'es' });
    expect(body.file.name).toBe('audio.ogg');
    expect(body.file.type).toBe('audio/ogg');
  });

  it('refuses audio types OpenAI does not accept, without calling it', async () => {
    const { client, create } = fakeClient({ text: 'x' });

    const error = await new OpenAiTranscriber(options, client)
      .transcribe({ audio: Buffer.from('amr'), mimeType: 'audio/amr' })
      .catch((e: unknown) => e);

    expect(error).toEqual(
      new AiProviderError('audio_type_not_supported', false),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('classifies OpenAI errors like the chat adapter', async () => {
    const { client } = fakeClient(
      new APIError(503, undefined, 'down', undefined),
    );

    const error = (await new OpenAiTranscriber(options, client)
      .transcribe({ audio: Buffer.from('x'), mimeType: 'audio/mpeg' })
      .catch((e: unknown) => e)) as AiProviderError;

    expect(error.code).toBe('openai_http_503');
    expect(error.retryable).toBe(true);
  });

  it('knows which types it transcribes', () => {
    expect(isTranscribable('audio/ogg; codecs=opus')).toBe(true);
    expect(isTranscribable('AUDIO/MPEG')).toBe(true);
    expect(isTranscribable('audio/aac')).toBe(false);
    expect(isTranscribable('audio/amr')).toBe(false);
  });
});
