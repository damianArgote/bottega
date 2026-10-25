import { Injectable } from '@nestjs/common';
import type { Lead, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  cleanLeadValues,
  type LeadValues,
  leadValuesOf,
  legacyColumnsFor,
} from './lead-values.js';

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates or updates the conversation's lead, merging the non-empty values
   * into Lead.data (so known data is never blanked) and setting its business.
   * The old keys also go to the fixed columns until 02b T7 drops them.
   * Returns null (and writes nothing) when no value has content. Throws a
   * ZodError on invalid keys or lengths.
   */
  async upsertFromConversation(
    conversationId: string,
    values: Record<string, string>,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Lead | null> {
    const cleaned = cleanLeadValues(values);
    if (Object.keys(cleaned).length === 0) {
      return null;
    }
    const [existing, conversation] = await Promise.all([
      tx.lead.findUnique({ where: { conversationId } }),
      tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { line: { select: { businessId: true } } },
      }),
    ]);
    // Read-modify-write is safe: jobs of one conversation run one at a time
    // and the caller's transaction holds the conversation row lock.
    const data: LeadValues = { ...leadValuesOf(existing), ...cleaned };
    const fields = {
      businessId: conversation.line.businessId,
      data,
      ...legacyColumnsFor(cleaned),
    };
    return tx.lead.upsert({
      where: { conversationId },
      create: { conversationId, ...fields },
      update: fields,
    });
  }
}
