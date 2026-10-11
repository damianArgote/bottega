import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ConversationMode,
  type DemoRequest,
  type Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BarbershopDemo } from '../content/content.schema.js';
import { ContentService } from '../content/content.service.js';

const field = z.string().trim().min(1).max(200).optional();

/** Fictitious booking data collected in the demo. Unknown keys rejected. */
export const demoRequestInputSchema = z
  .object({
    customerName: field,
    service: field,
    preferredDate: field,
    preferredTime: field,
    notes: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type DemoRequestInput = z.infer<typeof demoRequestInputSchema>;

export class DemoContextError extends Error {
  constructor() {
    super('demo requests can only be registered in a DEMO context');
    this.name = 'DemoContextError';
  }
}

/** Demo scenarios (fictitious businesses) and their captured requests. */
@Injectable()
export class DemosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentService,
  ) {}

  getBarbershop(): BarbershopDemo {
    return this.content.getBarbershop();
  }

  /**
   * Stores a fictitious booking (isFictitious=true) for the barbershop demo.
   * Validates the input (ZodError) and that `contextId` is a DEMO context of
   * the conversation (DemoContextError), so demo data never lands in a
   * commercial context.
   */
  async registerDemoRequest(
    conversationId: string,
    contextId: string,
    data: DemoRequestInput,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<DemoRequest> {
    const input = demoRequestInputSchema.parse(data);
    const context = await tx.conversationContext.findUnique({
      where: { id: contextId },
    });
    if (
      context?.conversationId !== conversationId ||
      context.mode !== ConversationMode.DEMO
    ) {
      throw new DemoContextError();
    }
    return tx.demoRequest.create({
      data: {
        conversationId,
        contextId,
        scenario: this.content.getBarbershop().scenario,
        isFictitious: true,
        ...input,
      },
    });
  }
}
