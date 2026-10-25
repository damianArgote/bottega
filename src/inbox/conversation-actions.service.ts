import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BusinessAccess } from '../auth/business-access.guard.js';
import type { SessionUser } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type AttendanceChange,
  handBack,
  release,
  resolve,
  take,
} from './conversation-state.js';
import { addSystemMessage } from './system-messages.js';

interface LockedRow {
  id: string;
  assignedToId: string | null;
  activeContextId: string | null;
  assigneeName: string | null;
}

/** What an action returns: the conversation's new attendance state. */
export interface AttendanceView {
  id: string;
  status: string;
  assignedTo: { id: string; name: string } | null;
  paused: boolean;
  version: number;
}

/**
 * Take, release, hand back and resolve (inbox). Each runs under the
 * conversation's row lock, so concurrent actions are serialized: of two
 * operators taking the same conversation, exactly one wins. Each leaves a
 * SYSTEM message in the thread.
 */
@Injectable()
export class ConversationActionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 409 if someone else has it, unless `force` (OWNER only, else 403).
   * Taking one you already have changes nothing.
   */
  async take(
    access: BusinessAccess,
    user: SessionUser,
    conversationId: string,
    { force }: { force: boolean },
  ): Promise<AttendanceView> {
    if (force && access.role !== 'OWNER') {
      throw new ForbiddenException('Only an OWNER can take it over (force)');
    }
    return this.act(access, conversationId, (row) => {
      if (row.assignedToId === user.id) {
        return null;
      }
      if (row.assignedToId && !force) {
        throw new ConflictException({
          message: `${row.assigneeName ?? 'Someone else'} already has this conversation`,
          code: 'ALREADY_TAKEN',
        });
      }
      return {
        change: take(user.id),
        note: row.assignedToId
          ? `${user.name} tomó la conversación (la tenía ${row.assigneeName})`
          : `${user.name} tomó la conversación`,
      };
    });
  }

  /** Only the assignee or an OWNER (409 otherwise). The bot stays quiet. */
  release(
    access: BusinessAccess,
    user: SessionUser,
    conversationId: string,
  ): Promise<AttendanceView> {
    return this.act(access, conversationId, (row) => {
      if (
        row.assignedToId &&
        row.assignedToId !== user.id &&
        access.role !== 'OWNER'
      ) {
        throw new ConflictException({
          message: 'Only the person attending it or an OWNER can release it',
          code: 'NOT_YOURS',
        });
      }
      return {
        change: release(),
        note: `${user.name} soltó la conversación`,
      };
    });
  }

  handBack(
    access: BusinessAccess,
    user: SessionUser,
    conversationId: string,
  ): Promise<AttendanceView> {
    return this.act(access, conversationId, () => ({
      change: handBack(),
      note: `${user.name} se la devolvió al bot`,
      closesHandoffs: true,
    }));
  }

  resolve(
    access: BusinessAccess,
    user: SessionUser,
    conversationId: string,
  ): Promise<AttendanceView> {
    return this.act(access, conversationId, () => ({
      change: resolve(),
      note: `${user.name} resolvió la conversación`,
      closesHandoffs: true,
    }));
  }

  /**
   * Locks the conversation (404 unless it belongs to the business), lets
   * `decide` return the change and its note (null: nothing to do), applies
   * both and returns the new state.
   */
  private async act(
    access: BusinessAccess,
    conversationId: string,
    decide: (row: LockedRow) => {
      change: AttendanceChange;
      note: string;
      /** The bot attends again: open handoff requests are done. */
      closesHandoffs?: boolean;
    } | null,
  ): Promise<AttendanceView> {
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<LockedRow[]>`
        SELECT c.id, c.assigned_to_id AS "assignedToId",
          c.active_context_id AS "activeContextId", u.name AS "assigneeName"
        FROM conversation c
        JOIN line l ON l.id = c.line_id
        LEFT JOIN app_user u ON u.id = c.assigned_to_id
        WHERE c.id = ${conversationId}::uuid
          AND l.business_id = ${access.businessId}::uuid
        FOR UPDATE OF c`;
      if (!row) {
        throw new NotFoundException('Conversation not found');
      }
      const decision = decide(row);
      if (decision) {
        await tx.conversation.update({
          where: { id: row.id },
          data: {
            ...decision.change,
            ...(decision.closesHandoffs ? { pausedAt: null } : {}),
          },
        });
        if (decision.closesHandoffs) {
          await tx.handoffRequest.updateMany({
            where: { conversationId: row.id, status: 'OPEN' },
            data: { status: 'RESOLVED', resolvedAt: new Date() },
          });
        }
        await addSystemMessage(tx, {
          conversationId: row.id,
          contextId: row.activeContextId,
          author: 'HUMAN',
          text: decision.note,
        });
      }
      const view = await tx.conversation.findUniqueOrThrow({
        where: { id: row.id },
        select: {
          id: true,
          status: true,
          paused: true,
          version: true,
          assignedTo: { select: { id: true, name: true } },
        },
      });
      return view;
    });
  }
}
