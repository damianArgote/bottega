import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  AgentActionCallStatus,
  AgentActionKind,
  Prisma,
} from '../generated/prisma/client.js';
import { fetchErrorCode } from '../integrations/webhook-delivery.service.js';
import {
  SIGNATURE_HEADER,
  signWebhook,
  TIMESTAMP_HEADER,
} from '../integrations/webhook-signature.js';
import { CredentialsDecryptError } from '../lines/credentials-cipher.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The fetch used for business actions (SSRF-safe; tests replace it). */
export const ACTION_FETCH = Symbol('ACTION_FETCH');

/** An action's answer may not be longer than this. */
export const ACTION_RESPONSE_MAX_BYTES = 8 * 1024;
/** The longest `reply` the bot sends as is. */
export const ACTION_REPLY_MAX_CHARS = 1000;

const responseSchema = z.object({
  reply: z.string().trim().min(1).max(ACTION_REPLY_MAX_CHARS).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** What a business action answered: `data` for the model, `reply` as is. */
export type ActionResult = z.infer<typeof responseSchema>;

export type ActionOutcome =
  | { ok: true; result: ActionResult; status: number | null }
  /** `error` is a static label (http_500, timeout, invalid_response...). */
  | { ok: false; error: string; status: number | null };

/** The stored action, as the caller needs it. */
export interface CallableAction {
  id: string;
  businessId: string;
  name: string;
  url: string;
  secretEncrypted: string;
  kind: AgentActionKind;
  timeoutMs: number;
}

export interface ActionRequest {
  idempotencyKey: string;
  conversationId: string | null;
  contact: { waId: string; name: string | null } | null;
  arguments: Record<string, unknown>;
  /** Set by the "probar" route, so the business can tell it apart. */
  test?: true;
}

/**
 * Calls business actions: a POST signed like the 07a events (HMAC-SHA256 of
 * `<timestamp>.<body>` with the action's secret) through the SSRF-safe
 * fetch, with the action's timeout and an 8 KB cap on the answer. Never
 * logs the URL, the arguments or the answer.
 */
@Injectable()
export class ActionCallerService {
  private readonly logger = new Logger(ActionCallerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    @Inject(ACTION_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * The bot's call. Each call is recorded by its idempotency key, unique per
   * business (it carries the action name, and the record outlives the
   * action). An EFFECT action is called at most once per key: when the key
   * was already used (a retried job), a success with the same arguments is
   * replayed from the record; other arguments (`arguments_changed`), a
   * failure or a call never answered (`already_attempted`) count as failed
   * without calling.
   */
  async call(
    action: CallableAction,
    request: ActionRequest,
  ): Promise<ActionOutcome & { replayed?: true }> {
    const key = {
      businessId: action.businessId,
      idempotencyKey: request.idempotencyKey,
    };
    const argumentsHash = hashArguments(request.arguments);
    let callId: string;
    try {
      callId = (
        await this.prisma.agentActionCall.create({
          data: {
            ...key,
            actionId: action.id,
            argumentsHash,
            conversationId: request.conversationId,
          },
          select: { id: true },
        })
      ).id;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const previous = await this.prisma.agentActionCall.findUniqueOrThrow({
        where: { businessId_idempotencyKey: key },
      });
      if (action.kind === AgentActionKind.EFFECT) {
        // A record from before the hash existed counts as the same call.
        const sameArguments =
          previous.argumentsHash === null ||
          previous.argumentsHash === argumentsHash;
        if (previous.status !== AgentActionCallStatus.SUCCEEDED) {
          return { ok: false, error: 'already_attempted', status: null };
        }
        if (!sameArguments) {
          return this.failed(action, 'arguments_changed', null);
        }
        return {
          ok: true,
          result: responseSchema.parse(previous.result ?? {}),
          status: previous.responseStatus,
          replayed: true,
        };
      }
      // A query only reads: asking again is safe.
      callId = previous.id;
      await this.prisma.agentActionCall.update({
        where: { id: callId },
        data: {
          actionId: action.id,
          argumentsHash,
          status: AgentActionCallStatus.PENDING,
          error: null,
          responseStatus: null,
          finishedAt: null,
        },
      });
    }

    const outcome = await this.send(action, request);
    await this.prisma.agentActionCall.update({
      where: { id: callId },
      data: outcome.ok
        ? {
            status: AgentActionCallStatus.SUCCEEDED,
            responseStatus: outcome.status,
            finishedAt: new Date(),
            // Kept only to replay an effect; a query's answer is not stored.
            ...(action.kind === AgentActionKind.EFFECT
              ? { result: outcome.result as Prisma.InputJsonValue }
              : {}),
          }
        : {
            status: AgentActionCallStatus.FAILED,
            error: outcome.error,
            responseStatus: outcome.status,
            finishedAt: new Date(),
          },
    });
    return outcome;
  }

  /** One signed POST and its parsed answer; never throws for the remote. */
  async send(
    action: CallableAction,
    request: ActionRequest,
  ): Promise<ActionOutcome> {
    let secret: string;
    try {
      secret = this.credentials.decrypt(action.secretEncrypted);
    } catch (error) {
      if (!(error instanceof CredentialsDecryptError)) {
        throw error;
      }
      return this.failed(action, 'secret_unreadable', null);
    }
    const body = JSON.stringify({
      idempotencyKey: request.idempotencyKey,
      action: action.name,
      businessId: action.businessId,
      conversationId: request.conversationId,
      contact: request.contact,
      arguments: request.arguments,
      ...(request.test ? { test: true } : {}),
    });
    const timestamp = Math.floor(Date.now() / 1000);

    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(action.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Bottega-Actions/1',
          'X-Bottega-Action': action.name,
          'X-Bottega-Idempotency-Key': request.idempotencyKey,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(action.timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      return this.failed(action, fetchErrorCode(error), null);
    }
    if (status < 200 || status >= 300) {
      return this.failed(action, `http_${status}`, status);
    }
    if (Buffer.byteLength(text) > ACTION_RESPONSE_MAX_BYTES) {
      return this.failed(action, 'response_too_large', status);
    }
    let parsed: unknown = {};
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        return this.failed(action, 'invalid_response', status);
      }
    }
    const result = responseSchema.safeParse(parsed);
    if (!result.success) {
      return this.failed(action, 'invalid_response', status);
    }
    return { ok: true, result: result.data, status };
  }

  private failed(
    action: CallableAction,
    error: string,
    status: number | null,
  ): ActionOutcome {
    this.logger.warn(
      `Business action failed business=${action.businessId} action=${action.id} code=${error}`,
    );
    return { ok: false, error, status };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** SHA-256 of the arguments as canonical JSON (keys sorted). */
export function hashArguments(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
