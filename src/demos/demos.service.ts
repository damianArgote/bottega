import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ConversationMode,
  type DemoRequest,
  type Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ContentService } from '../content/content.service.js';
import { type DemoScenario, demoScenarioOf } from './demo-scenarios.js';

const field = z.string().trim().min(1).max(200).optional();

/**
 * Fictitious request collected in a demo (a booking, or the quote the user
 * chose in the insurance demo, whose data goes in `details`). Unknown keys
 * rejected.
 */
export const demoRequestInputSchema = z
  .object({
    customerName: field,
    service: field,
    preferredDate: field,
    preferredTime: field,
    notes: z.string().trim().min(1).max(500).optional(),
    details: z
      .record(
        z.string().max(50),
        z.union([z.string().max(200), z.number(), z.boolean()]),
      )
      .optional(),
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

  /**
   * Stores a fictitious request (isFictitious=true) of a demo scenario.
   * Validates the input (ZodError) and that `contextId` is a DEMO context of
   * the conversation running that scenario (DemoContextError), so demo data
   * never lands in a commercial context or another demo.
   */
  async registerDemoRequest(
    conversationId: string,
    contextId: string,
    scenario: DemoScenario,
    data: DemoRequestInput,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<DemoRequest> {
    const input = demoRequestInputSchema.parse(data);
    const context = await tx.conversationContext.findUnique({
      where: { id: contextId },
    });
    if (
      context?.conversationId !== conversationId ||
      context.mode !== ConversationMode.DEMO ||
      demoScenarioOf(context.demoScenario) !== scenario
    ) {
      throw new DemoContextError();
    }
    return tx.demoRequest.create({
      data: {
        conversationId,
        contextId,
        scenario,
        isFictitious: true,
        ...input,
      },
    });
  }
}
