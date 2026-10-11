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
      const handoff = await t.handoffRequest.create({
        data: { conversationId, reason, status: HandoffStatus.OPEN },
      });
      return handoff.id;
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
