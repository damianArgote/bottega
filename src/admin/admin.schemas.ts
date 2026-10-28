import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  HandoffStatus,
  LeadStatus,
  MessageStatus,
} from '../generated/prisma/client.js';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const MAX_HUMAN_REPLY_LENGTH = 4096;

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_LIST_LIMIT)
  .default(DEFAULT_LIST_LIMIT);

export const conversationIdSchema = z.uuid();

/** WhatsApp ids are phone numbers in international format, digits only. */
export const waIdSchema = z.string().regex(/^\d{6,20}$/, 'must be 6-20 digits');

const digits = (name: string) =>
  z.string().regex(/^\d{5,30}$/, `${name} must be 5-30 digits`);

export const businessIdSchema = z.uuid();

export const createBusinessBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'must be lowercase letters, digits and dashes',
      )
      .max(50),
    /** How the bot introduces itself, e.g. "Ana, IA de Peluquería Ana". */
    botName: z.string().trim().min(1).max(100),
  })
  .strict();

export const MIN_PASSWORD_LENGTH = 10;

/** POST /admin/businesses/:id/users. */
export const addUserBodySchema = z
  .object({
    email: z.string().trim().pipe(z.email()),
    name: z.string().trim().min(1).max(100),
    password: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `must be at least ${MIN_PASSWORD_LENGTH} characters`,
      )
      .max(200),
    role: z.enum(['OWNER', 'AGENT']),
  })
  .strict();

export const createLineBodySchema = z
  .object({
    phoneNumberId: digits('phoneNumberId'),
    wabaId: digits('wabaId'),
    appId: digits('appId'),
    appSecret: z.string().trim().min(8).max(200),
    /** System User token of the client's Meta app. */
    accessToken: z.string().trim().min(20).max(2000),
    displayPhone: z.string().trim().min(1).max(30).optional(),
  })
  .strict();

export const leadsQuerySchema = z.object({
  status: z.enum(LeadStatus).optional(),
  limit,
});

export const handoffsQuerySchema = z.object({
  status: z.enum(HandoffStatus).optional(),
  limit,
});

/** Outbound sends that need a human look. Both when no status is given. */
export const ATTENTION_STATUSES = [
  MessageStatus.UNCERTAIN,
  MessageStatus.FAILED,
] as const;

export const messagesQuerySchema = z.object({
  status: z.enum(ATTENTION_STATUSES).optional(),
  limit,
});

export const conversationQuerySchema = z.object({ limit });

export const resumeBodySchema = z
  .object({ resolveHandoffs: z.boolean().default(true) })
  .strict();

export const humanReplyBodySchema = z
  .object({ text: z.string().trim().min(1).max(MAX_HUMAN_REPLY_LENGTH) })
  .strict();

/** Optional `Idempotency-Key` header of a human reply. */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,100}$/, 'must be 1-100 chars of [A-Za-z0-9._:-]')
  .optional();

/** Parses `value` or throws a 400 listing each problem (paths and rules only). */
export const MAX_PREVIEW_MESSAGES = 20;
/** Shorter than a human reply: each preview message is resent to the model. */
export const MAX_PREVIEW_MESSAGE_LENGTH = 1_000;

/** POST /admin/businesses/:id/agent/preview: the conversation so far. */
export const agentPreviewBodySchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(MAX_PREVIEW_MESSAGE_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PREVIEW_MESSAGES)
      .refine((messages) => messages.at(-1)?.role === 'user', {
        message: 'the last message must be from the user',
      }),
  })
  .strict();

/** No body, or `{}`: the request carries no fields. */
export function isEmptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    (typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0)
  );
}

export function parseOrBadRequest<T extends z.ZodType>(
  schema: T,
  value: unknown,
  label: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: result.error.issues.map((issue) => {
      const path = [label, ...issue.path.map(String)].join('.');
      return `${path}: ${issue.message}`;
    }),
  });
}
