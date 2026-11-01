import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { isToolName } from '../bot/tools/registry.js';
import {
  AgentActionKind,
  Prisma,
  type AgentAction,
} from '../generated/prisma/client.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ActionCallerService,
  type ActionOutcome,
} from './action-caller.service.js';
import {
  actionArgumentsSchema,
  actionParametersSchema,
  type ActionParameters,
} from './action-parameters.js';

/** The longest timeout an action may have. */
export const MAX_ACTION_TIMEOUT_MS = 10_000;

const ACTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const name = z
  .string()
  .regex(ACTION_NAME, { message: 'must be snake_case (a-z, 0-9, _)' })
  .refine((value) => !isToolName(value), {
    message: 'is the name of a built-in tool',
  });
const kind = z.enum(['query', 'effect']);
const httpsUrl = z
  .url({ protocol: /^https$/, message: 'must be an https URL' })
  .max(2000);
const timeoutMs = z.number().int().min(500).max(MAX_ACTION_TIMEOUT_MS);

export const createActionSchema = z
  .object({
    name,
    description: z.string().trim().min(1).max(1000),
    parameters: actionParametersSchema.default({
      type: 'object',
      properties: {},
      required: [],
    }),
    url: httpsUrl,
    kind,
    timeoutMs: timeoutMs.default(5000),
    active: z.boolean().default(true),
  })
  .strict();
export const updateActionSchema = z
  .object({
    description: z.string().trim().min(1).max(1000).optional(),
    parameters: actionParametersSchema.optional(),
    url: httpsUrl.optional(),
    kind: kind.optional(),
    timeoutMs: timeoutMs.optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const testActionSchema = z
  .object({ arguments: z.record(z.string(), z.unknown()).default({}) })
  .strict();

const KIND_TO_DB = {
  query: AgentActionKind.QUERY,
  effect: AgentActionKind.EFFECT,
} as const;

/** How an action is shown: never its secret. */
export function actionView(action: AgentAction) {
  return {
    id: action.id,
    name: action.name,
    description: action.description,
    parameters: action.parameters as ActionParameters,
    url: action.url,
    kind: action.kind === AgentActionKind.EFFECT ? 'effect' : 'query',
    timeoutMs: action.timeoutMs,
    active: action.active,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

/** What the "probar" route answers. */
export type ActionTestResult =
  | {
      ok: true;
      status: number | null;
      reply: string | null;
      data: Record<string, unknown> | null;
    }
  | { ok: false; status: number | null; error: string };

/**
 * A business's actions, for the admin API and the staff routes (create,
 * edit, test, delete) and the owner's read-only list. The signing secret
 * is returned only when created or rotated. Every call is scoped to the
 * business (404 otherwise).
 */
@Injectable()
export class AgentActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly caller: ActionCallerService,
  ) {}

  async list(businessId: string) {
    await this.business(businessId);
    const actions = await this.prisma.agentAction.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
    });
    return actions.map(actionView);
  }

  /** Returns the action and its signing `secret` (shown once). */
  async create(businessId: string, input: z.infer<typeof createActionSchema>) {
    await this.business(businessId);
    const secret = newSecret();
    try {
      const action = await this.prisma.agentAction.create({
        data: {
          businessId,
          name: input.name,
          description: input.description,
          parameters: input.parameters,
          url: input.url,
          kind: KIND_TO_DB[input.kind],
          timeoutMs: input.timeoutMs,
          active: input.active,
          secretEncrypted: this.credentials.encrypt(secret),
        },
      });
      return { ...actionView(action), secret };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          message: 'The business already has an action with that name',
          code: 'ACTION_NAME_TAKEN',
        });
      }
      throw error;
    }
  }

  async update(
    businessId: string,
    actionId: string,
    input: z.infer<typeof updateActionSchema>,
  ) {
    await this.action(businessId, actionId);
    const { kind: newKind, parameters, ...rest } = input;
    const action = await this.prisma.agentAction.update({
      where: { id: actionId },
      data: {
        ...rest,
        ...(newKind ? { kind: KIND_TO_DB[newKind] } : {}),
        ...(parameters
          ? { parameters: parameters }
          : {}),
      },
    });
    return actionView(action);
  }

  /** A new secret; the old one stops signing at once. Shown once. */
  async rotateSecret(businessId: string, actionId: string) {
    await this.action(businessId, actionId);
    const secret = newSecret();
    const action = await this.prisma.agentAction.update({
      where: { id: actionId },
      data: { secretEncrypted: this.credentials.encrypt(secret) },
    });
    return { ...actionView(action), secret };
  }

  async delete(businessId: string, actionId: string) {
    await this.action(businessId, actionId);
    await this.prisma.agentAction.delete({ where: { id: actionId } });
  }

  /**
   * "Probar": calls the action once with example arguments (validated with
   * its parameters, 400 otherwise), marked `test: true` and with no
   * conversation, and shows what it answered. Not recorded as a bot call.
   */
  async test(
    businessId: string,
    actionId: string,
    input: z.infer<typeof testActionSchema>,
  ): Promise<ActionTestResult> {
    const action = await this.action(businessId, actionId);
    const args = actionArgumentsSchema(
      action.parameters as ActionParameters,
    ).safeParse(input.arguments);
    if (!args.success) {
      return {
        ok: false,
        status: null,
        error: `invalid_arguments: ${args.error.issues
          .map((issue) => issue.path.map(String).join('.') || '(root)')
          .join(', ')}`,
      };
    }
    const outcome: ActionOutcome = await this.caller.send(action, {
      idempotencyKey: `test:${randomUUID()}`,
      conversationId: null,
      contact: null,
      arguments: args.data,
      test: true,
    });
    return outcome.ok
      ? {
          ok: true,
          status: outcome.status,
          reply: outcome.result.reply ?? null,
          data: outcome.result.data ?? null,
        }
      : { ok: false, status: outcome.status, error: outcome.error };
  }

  /** The active actions the agent of `businessId` gets as tools. */
  active(businessId: string): Promise<AgentAction[]> {
    return this.prisma.agentAction.findMany({
      where: { businessId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  private async business(businessId: string): Promise<void> {
    const found = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Business not found');
    }
  }

  private async action(businessId: string, actionId: string) {
    const found = await this.prisma.agentAction.findFirst({
      where: { id: actionId, businessId },
    });
    if (!found) {
      throw new NotFoundException('Action not found');
    }
    return found;
  }
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
