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
