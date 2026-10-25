import { Injectable } from '@nestjs/common';
import {
  ContextEndReason,
  ConversationMode,
  HandoffStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type Tx = Prisma.TransactionClient;

export interface LockedConversation {
  id: string;
  mode: ConversationMode;
  paused: boolean;
  activeContextId: string | null;
}

export interface PauseResult {
  /** The conversation was already paused before this call. */
  wasPaused: boolean;
  /** The open handoff request (the existing one, or the one created). */
  handoffId: string;
  handoffCreated: boolean;
}

export interface ResumeResult {
  /** The conversation was paused before this call. */
  wasPaused: boolean;
  resolvedHandoffs: number;
}

/**
 * Context and pause changes of a conversation. Each operation runs in the
 * caller's transaction when `tx` is given (so it commits together with the
 * job's phase marker), or in its own transaction otherwise. Nothing is ever
 * deleted: a context is closed (endedAt/endReason) and a new one is opened.
 */
@Injectable()
export class ContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Locks the conversation row until the transaction ends, serializing
   * context changes with concurrent inbound inserts of the same user.
   */
  async lock(tx: Tx, conversationId: string): Promise<LockedConversation> {
    const [row] = await tx.$queryRaw<LockedConversation[]>`
      SELECT id, mode, paused, active_context_id AS "activeContextId"
      FROM conversation WHERE id = ${conversationId}::uuid FOR UPDATE`;
    if (!row) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    return row;
  }

  /** Closes the active context and opens a fresh one of mode `to`. */
  switchMode(
    conversationId: string,
    to: ConversationMode,
    tx?: Tx,
  ): Promise<string> {
    return this.inTx(tx, async (t) => {
      await this.lock(t, conversationId);
      return this.replaceContext(
        t,
        conversationId,
        to,
        ContextEndReason.MODE_SWITCH,
      );
    });
  }

  /** Closes the active context and opens a new one of the same mode. */
  resetContext(conversationId: string, tx?: Tx): Promise<string> {
    return this.inTx(tx, async (t) => {
      const { mode } = await this.lock(t, conversationId);
      return this.replaceContext(
        t,
        conversationId,
        mode,
        ContextEndReason.RESET,
      );
    });
  }

  /** Pauses the bot and opens a handoff request. Returns its id. */
  requestHuman(
    conversationId: string,
    reason: string,
    tx?: Tx,
  ): Promise<string> {
    return this.inTx(tx, async (t) => {
      await this.lock(t, conversationId);
      await t.conversation.update({
        where: { id: conversationId },
        data: { paused: true, pausedAt: new Date() },
      });
      // TODO(prompt 04): also mark the conversation as pending for the inbox
      // (taken/returned by a person); until then the open HandoffRequest and
      // the pause are what the team sees.
      const handoff = await t.handoffRequest.create({
        data: { conversationId, reason, status: HandoffStatus.OPEN },
      });
      return handoff.id;
    });
  }

  /**
   * Pauses the bot (idempotent) and opens a handoff request only when the
   * conversation has none open. `pausedAt` keeps the original pause time.
   */
  pause(conversationId: string, reason: string, tx?: Tx): Promise<PauseResult> {
    return this.inTx(tx, async (t) => {
      const { paused } = await this.lock(t, conversationId);
      if (!paused) {
        await t.conversation.update({
          where: { id: conversationId },
          data: { paused: true, pausedAt: new Date() },
        });
      }
      const open = await t.handoffRequest.findFirst({
        where: { conversationId, status: HandoffStatus.OPEN },
        orderBy: { createdAt: 'asc' },
      });
      if (open) {
        return { wasPaused: paused, handoffId: open.id, handoffCreated: false };
      }
      const handoff = await t.handoffRequest.create({
        data: { conversationId, reason, status: HandoffStatus.OPEN },
      });
      return { wasPaused: paused, handoffId: handoff.id, handoffCreated: true };
    });
  }

  /**
   * Resumes the bot (idempotent), optionally resolving every open handoff.
   * Messages received while paused are not answered retroactively.
   */
  resume(
    conversationId: string,
    resolveHandoffs: boolean,
    tx?: Tx,
  ): Promise<ResumeResult> {
    return this.inTx(tx, async (t) => {
      const { paused } = await this.lock(t, conversationId);
      if (paused) {
        await t.conversation.update({
          where: { id: conversationId },
          data: { paused: false, pausedAt: null },
        });
      }
      let resolvedHandoffs = 0;
      if (resolveHandoffs) {
        const { count } = await t.handoffRequest.updateMany({
          where: { conversationId, status: HandoffStatus.OPEN },
          data: { status: HandoffStatus.RESOLVED, resolvedAt: new Date() },
        });
        resolvedHandoffs = count;
      }
      return { wasPaused: paused, resolvedHandoffs };
    });
  }

  private async replaceContext(
    tx: Tx,
    conversationId: string,
    mode: ConversationMode,
    endReason: ContextEndReason,
  ): Promise<string> {
    await tx.conversationContext.updateMany({
      where: { conversationId, endedAt: null },
      data: { endedAt: new Date(), endReason },
    });
    const context = await tx.conversationContext.create({
      data: { conversationId, mode },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { mode, activeContextId: context.id },
    });
    return context.id;
  }

  private inTx<T>(tx: Tx | undefined, run: (tx: Tx) => Promise<T>) {
    return tx ? run(tx) : this.prisma.$transaction(run);
  }
}
