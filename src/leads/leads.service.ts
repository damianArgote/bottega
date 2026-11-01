import { Injectable } from '@nestjs/common';
import type { Lead, Prisma } from '../generated/prisma/client.js';
import { enqueueEvent } from '../integrations/events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  cleanLeadValues,
  type LeadValues,
  leadValuesOf,
} from './lead-values.js';

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates or updates the conversation's lead, merging the non-empty values
   * into Lead.data (so known data is never blanked) and setting its business.
   * Returns null (and writes nothing) when no value has content. Throws a
   * ZodError on invalid keys or lengths. Enqueues `lead.updated` (webhooks)
   * when a value changed.
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
    const fields = { businessId: conversation.line.businessId, data };
    const lead = await tx.lead.upsert({
      where: { conversationId },
      create: { conversationId, ...fields },
      update: fields,
    });
    if (!existing || changed(leadValuesOf(existing), data)) {
      await enqueueEvent(tx, {
        conversationId,
        type: 'lead.updated',
        data: {
          lead: {
            id: lead.id,
            status: lead.status,
            data: lead.data,
            createdAt: lead.createdAt.toISOString(),
          },
        },
      });
    }
    return lead;
  }
}

function changed(before: LeadValues, after: LeadValues): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].some((key) => before[key] !== after[key]);
}
