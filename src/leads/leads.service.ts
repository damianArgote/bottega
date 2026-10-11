import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Lead, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const field = z.string().max(500).optional();

/** Lead fields the bot may capture. Unknown keys are rejected. */
export const leadFieldsSchema = z
  .object({
    name: field,
    businessName: field,
    industry: field,
    need: field,
    contactNotes: field,
  })
  .strict();

export type LeadFields = z.infer<typeof leadFieldsSchema>;

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates or updates the conversation's lead with the non-empty fields
   * only, so known data is never blanked. Returns null (and writes nothing)
   * when no field has content. Throws a ZodError on invalid input.
   */
  async upsertFromConversation(
    conversationId: string,
    fields: LeadFields,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Lead | null> {
    const parsed = leadFieldsSchema.parse(fields);
    const data: LeadFields = {};
    for (const [key, value] of Object.entries(parsed)) {
      const trimmed = value?.trim();
      if (trimmed) {
        data[key as keyof LeadFields] = trimmed;
      }
    }
    if (Object.keys(data).length === 0) {
      return null;
    }
    return tx.lead.upsert({
      where: { conversationId },
      create: { conversationId, ...data },
      update: data,
    });
  }
}
