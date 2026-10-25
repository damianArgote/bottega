import { Logger } from '@nestjs/common';
import { maskPhone, type SendOutcome } from './whatsapp.client.js';

export interface GraphClientOptions {
  /** e.g. `v26.0` */
  apiVersion: string;
  timeoutMs: number;
  baseUrl?: string;
}

/** The sending line: its Meta phone number id and decrypted access token. */
export interface LineSendCredentials {
  phoneNumberId: string;
  accessToken: string;
}

/** Network error codes raised before any request byte reached Meta. */
const PRE_SEND_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Meta error codes meaning "not accepted now, try later":
 * 4 app rate limit, 80007 WABA rate limit, 130429 throughput limit,
 * 131056 too many messages to the same recipient.
 */
const RETRYABLE_META_CODES = new Set([4, 80007, 130429, 131056]);

const MAX_ERROR_MESSAGE_LENGTH = 200;

interface GraphErrorBody {
  error?: { code?: unknown; message?: unknown };
}

interface GraphSuccessBody {
  messages?: Array<{ id?: unknown }>;
}

/**
 * WhatsApp Cloud API adapter (`POST /{version}/{phone-number-id}/messages`).
 * The phone number id and token come with each call (one Meta app and token
 * per line). Never throws: every failure is classified into a
 * {@link SendOutcome}. Never logs the access token, the message body, or
 * full phone numbers.
 */
export class GraphWhatsAppClient {
  private readonly logger = new Logger(GraphWhatsAppClient.name);
  private readonly baseUrl: string;

  constructor(
    private readonly options: GraphClientOptions,
    private readonly fetchImpl: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    this.baseUrl = `${options.baseUrl ?? 'https://graph.facebook.com'}/${options.apiVersion}`;
  }

  async sendText(
    line: LineSendCredentials,
    to: string,
    body: string,
  ): Promise<SendOutcome> {
    const outcome = await this.send(line, to, body);
    this.logOutcome(to, outcome);
    return outcome;
  }

  private async send(
    line: LineSendCredentials,
    to: string,
    body: string,
  ): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/${line.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${line.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { preview_url: false, body },
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch (error) {
      return classifyNetworkError(error);
    }

    if (response.status >= 500) {
      return { kind: 'uncertain', reason: `http ${response.status}` };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (response.ok) {
      const id = (payload as GraphSuccessBody | undefined)?.messages?.[0]?.id;
      return typeof id === 'string' && id.length > 0
        ? { kind: 'sent', waMessageId: id }
        : { kind: 'uncertain', reason: '2xx response without message id' };
    }

    return classifyErrorResponse(response.status, payload);
  }

  private logOutcome(to: string, outcome: SendOutcome): void {
    const recipient = maskPhone(to);
    switch (outcome.kind) {
      case 'sent':
        this.logger.log(`Message accepted by Meta for ${recipient}`);
        return;
      case 'rejected':
        this.logger.warn(
          `Message rejected for ${recipient}: code=${outcome.code} http=${outcome.httpStatus ?? 'none'} retryable=${outcome.retryable}`,
        );
        return;
      case 'uncertain':
        this.logger.warn(
          `Send outcome uncertain for ${recipient}: ${outcome.reason}`,
        );
        return;
    }
  }
}

function classifyErrorResponse(
  httpStatus: number,
  payload: unknown,
): SendOutcome {
  const error = (payload as GraphErrorBody | undefined)?.error;
  const code = typeof error?.code === 'number' ? error.code : httpStatus;
  const message =
    typeof error?.message === 'string'
      ? error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
      : `http ${httpStatus}`;
  const retryable =
    httpStatus === 429 ||
    (typeof code === 'number' && RETRYABLE_META_CODES.has(code));
  return { kind: 'rejected', code, httpStatus, message, retryable };
}

function classifyNetworkError(error: unknown): SendOutcome {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return { kind: 'uncertain', reason: 'request timed out or was aborted' };
  }
  const code = networkErrorCode(error);
  if (code && PRE_SEND_NETWORK_CODES.has(code)) {
    return {
      kind: 'rejected',
      code,
      httpStatus: null,
      message: 'connection could not be established',
      retryable: true,
    };
  }
  return {
    kind: 'uncertain',
    reason: `network error${code ? ` (${code})` : ''}`,
  };
}

/** Finds a Node/undici error code on the error or its (nested) cause. */
function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return candidate.code;
    }
    if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      current = candidate.errors[0];
      continue;
    }
    current = candidate.cause;
  }
  return undefined;
}
