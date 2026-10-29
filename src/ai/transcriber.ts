import OpenAI, { toFile } from 'openai';
import { AiProviderError } from './ai.provider.js';
import { classifyOpenAiError } from './openai.provider.js';

/** An audio to transcribe (never logged). */
export interface TranscriptionInput {
  audio: Buffer;
  /** e.g. `audio/ogg; codecs=opus`. */
  mimeType: string;
}

export interface Transcription {
  text: string;
  /** Model that transcribed it. */
  model: string;
}

/**
 * Port for speech-to-text. Throws {@link AiProviderError} on failure, with
 * `retryable` telling whether trying again later may work.
 */
export interface AiTranscriber {
  transcribe(input: TranscriptionInput): Promise<Transcription>;
}

export const AI_TRANSCRIBER = Symbol('AI_TRANSCRIBER');

/** Used in echo mode, where no API key is configured and no call is made. */
export const disabledTranscriber: AiTranscriber = {
  transcribe: () => Promise.reject(new AiProviderError('ai_disabled', false)),
};

/** The part of the OpenAI client this adapter uses (mockable in tests). */
export interface TranscriptionsClient {
  audio: {
    transcriptions: {
      create(body: {
        file: Awaited<ReturnType<typeof toFile>>;
        model: string;
        language: string;
      }): Promise<{ text: string }>;
    };
  };
}

/** File extension OpenAI recognizes for each accepted audio type. */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

/** Audio types the bot transcribes (base type, parameters ignored). */
export function isTranscribable(mimeType: string): boolean {
  return baseType(mimeType) in EXTENSIONS;
}

const baseType = (mimeType: string) =>
  mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

/**
 * AiTranscriber over OpenAI's transcription API, in Spanish. Like the chat
 * adapter: `maxRetries: 0` (the job queue owns retries), nothing logged.
 */
export class OpenAiTranscriber implements AiTranscriber {
  private readonly client: TranscriptionsClient;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      timeoutMs: number;
    },
    client?: TranscriptionsClient,
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: options.apiKey,
        timeout: options.timeoutMs,
        maxRetries: 0,
      });
  }

  async transcribe({
    audio,
    mimeType,
  }: TranscriptionInput): Promise<Transcription> {
    const type = baseType(mimeType);
    const extension = EXTENSIONS[type];
    if (!extension) {
      throw new AiProviderError('audio_type_not_supported', false);
    }
    try {
      const result = await this.client.audio.transcriptions.create({
        file: await toFile(audio, `audio.${extension}`, { type }),
        model: this.options.model,
        language: 'es',
      });
      return { text: result.text.trim(), model: this.options.model };
    } catch (error) {
      throw classifyOpenAiError(error);
    }
  }
}
