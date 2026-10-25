import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { BusinessAccess } from '../auth/business-access.guard.js';
import type { SessionUser } from '../auth/auth.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type InboxView = 'mine' | 'unassigned' | 'pending' | 'resolved';

export const LIST_PAGE_SIZE = 30;
export const CHANGES_PAGE_SIZE = 200;
export const MESSAGES_PAGE_SIZE = 50;

/** What the inbox list and /changes return for each conversation. */
const conversationItem = {
  id: true,
  lineId: true,
  contact: { select: { id: true, waId: true, profileName: true } },
  mode: true,
  status: true,
  assignedTo: { select: { id: true, name: true } },
  paused: true,
  unreadCount: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  windowExpiresAt: true,
  version: true,
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{
  select: typeof conversationItem;
}>;

function toItem({ contact, ...row }: ConversationRow) {
  return {
    ...row,
    contact: { id: contact.id, waId: contact.waId, name: contact.profileName },
  };
}

export type ConversationItem = ReturnType<typeof toItem>;

const messageItem = {
  id: true,
  seq: true,
  direction: true,
  author: true,
  type: true,
  content: true,
  status: true,
  errorCode: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

/** Cursors are opaque to the web: base64url JSON. */
function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

/** `at` null: the page ended among conversations without lastMessageAt. */
const listCursorSchema = z.object({
  at: z.iso.datetime().nullable(),
  id: z.uuid(),
});
const txid = z.string().regex(/^\d{1,19}$/);
const changesCursorSchema = z.object({
  t: txid,
  i: z.uuid().optional(),
  /** Lowest xmin seen while paging (see changes()). */
  f: txid.optional(),
});

const minTxid = (a: string, b: string) => (BigInt(a) < BigInt(b) ? a : b);
const seqSchema = z.string().regex(/^\d{1,19}$/, 'must be a message seq');

/** Reads of the inbox, always scoped to the route's business. */
@Injectable()
export class InboxQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /conversations: one view, newest first by (lastMessageAt, id),
   * LIST_PAGE_SIZE per page. `mine`: assigned to the user, not resolved;
   * `unassigned`: nobody attends it and it is open; `pending`: waiting for a
   * person; `resolved`. Conversations without lastMessageAt (rows the
   * previous release wrote during a deploy) come last.
   */
  async list(
    access: BusinessAccess,
    user: SessionUser,
    query: { view: InboxView; lineId?: string; q?: string; cursor?: string },
  ) {
    if (query.lineId) {
      await this.lineOfBusiness(access, query.lineId);
    }
    const after = query.cursor
      ? decodeCursor(query.cursor, listCursorSchema)
      : null;
    const views: Record<InboxView, Prisma.ConversationWhereInput> = {
      mine: { assignedToId: user.id, status: { not: 'RESOLVED' } },
      unassigned: { assignedToId: null, status: 'OPEN' },
      pending: { status: 'PENDING' },
      resolved: { status: 'RESOLVED' },
    };
    const q = query.q?.trim();
    const rows = await this.prisma.conversation.findMany({
      where: {
        AND: [
          views[query.view],
          { line: { businessId: access.businessId } },
          query.lineId ? { lineId: query.lineId } : {},
          q
            ? {
                contact: {
                  OR: [
                    { profileName: { contains: q, mode: 'insensitive' } },
                    { waId: { contains: q } },
                  ],
                },
              }
            : {},
          after === null
            ? {}
            : after.at === null
              ? { lastMessageAt: null, id: { lt: after.id } }
              : {
                  OR: [
                    { lastMessageAt: { lt: new Date(after.at) } },
                    { lastMessageAt: new Date(after.at), id: { lt: after.id } },
                    // Rows without it sort last (nulls last).
                    { lastMessageAt: null },
                  ],
                },
        ],
      },
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ],
      take: LIST_PAGE_SIZE + 1,
      select: conversationItem,
    });
    const page = rows.slice(0, LIST_PAGE_SIZE);
    const last = page.at(-1);
    return {
      conversations: page.map(toItem),
      nextCursor:
        rows.length > LIST_PAGE_SIZE && last
          ? encodeCursor({
              at: last.lastMessageAt?.toISOString() ?? null,
              id: last.id,
            })
          : null,
    };
  }

  /**
   * GET /changes: conversations changed since the cursor, ordered by
   * (change_txid, id), at most CHANGES_PAGE_SIZE. The trigger stamps each
   * write with its transaction id; the new cursor is the oldest transaction
   * still running when this statement took its snapshot (pg_snapshot_xmin),
   * so a transaction that started earlier and commits later is read next
   * time instead of being skipped. Rows may repeat: the web keeps the
   * highest version per id. When the page is cut, the cursor is the last
   * row returned, so the next call continues right after it, and it also
   * carries the lowest xmin seen so the chain's end restarts from there. One statement,
   * no session state: safe behind Neon's pooler in transaction mode.
   */
  async changes(access: BusinessAccess, cursor: string | undefined) {
    const from = cursor
      ? decodeCursor(cursor, changesCursorSchema)
      : { t: '0' };
    const since = from.i
      ? Prisma.sql`(c.change_txid > ${from.t}::bigint
          OR (c.change_txid = ${from.t}::bigint AND c.id > ${from.i}::uuid))`
      : Prisma.sql`c.change_txid >= ${from.t}::bigint`;
    const rows = await this.prisma.$queryRaw<
      { xmin: string; id: string | null; txid: string | null }[]
    >`
      WITH snap AS (
        SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin
      ),
      changed AS (
        SELECT c.id, c.change_txid
        FROM conversation c
        JOIN line l ON l.id = c.line_id
        WHERE l.business_id = ${access.businessId}::uuid AND ${since}
        ORDER BY c.change_txid, c.id
        LIMIT ${CHANGES_PAGE_SIZE + 1}
      )
      SELECT snap.xmin, changed.id, changed.change_txid::text AS txid
      FROM snap LEFT JOIN changed ON true
      ORDER BY changed.change_txid, changed.id`;
    const xmin = rows[0]!.xmin;
    // While a cut page chain continues after its last row, older
    // transactions still running may commit below it: the chain carries the
    // lowest xmin it saw and, once it ends, resumes from there (rows may
    // repeat, never be lost).
    const floor = from.f ? minTxid(from.f, xmin) : xmin;
    const changed = rows.filter(
      (r): r is { xmin: string; id: string; txid: string } => r.id !== null,
    );
    const hasMore = changed.length > CHANGES_PAGE_SIZE;
    const page = changed.slice(0, CHANGES_PAGE_SIZE);
    const last = page.at(-1);

    const loaded = await this.prisma.conversation.findMany({
      where: { id: { in: page.map((r) => r.id) } },
      select: conversationItem,
    });
    const byId = new Map(loaded.map((row) => [row.id, row]));
    return {
      conversations: page.flatMap((r) => {
        const row = byId.get(r.id);
        return row ? [toItem(row)] : [];
      }),
      cursor: encodeCursor(
        hasMore && last ? { t: last.txid, i: last.id, f: floor } : { t: floor },
      ),
      hasMore,
    };
  }

  /**
   * GET /conversations/:id/messages: MESSAGES_PAGE_SIZE by seq (insertion
   * order), oldest first. Without parameters the latest page; `before` the
   * page just older than a seq; `after` the messages newer than a seq.
   */
  async messages(
    access: BusinessAccess,
    conversationId: string,
    query: { before?: string; after?: string },
  ) {
    if (query.before && query.after) {
      throw new BadRequestException('Use before or after, not both');
    }
    const before = query.before ? this.seq(query.before) : undefined;
    const after = query.after ? this.seq(query.after) : undefined;
    await this.conversationOfBusiness(access, conversationId);

    const newerFirst = after === undefined;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(before !== undefined ? { seq: { lt: before } } : {}),
        ...(after !== undefined ? { seq: { gt: after } } : {}),
      },
      orderBy: { seq: newerFirst ? 'desc' : 'asc' },
      take: MESSAGES_PAGE_SIZE + 1,
      select: messageItem,
    });
    const page = rows.slice(0, MESSAGES_PAGE_SIZE);
    if (newerFirst) {
      page.reverse();
    }
    return {
      messages: page.map((m) => ({ ...m, seq: m.seq.toString() })),
      hasMore: rows.length > MESSAGES_PAGE_SIZE,
    };
  }

  /** GET /lines: the business's WhatsApp lines (never their credentials). */
  async lines(access: BusinessAccess) {
    const lines = await this.prisma.line.findMany({
      where: { businessId: access.businessId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        phoneNumberId: true,
        displayPhone: true,
        active: true,
      },
    });
    return { lines };
  }

  private async conversationOfBusiness(
    access: BusinessAccess,
    conversationId: string,
  ): Promise<void> {
    const found = await this.prisma.conversation.findFirst({
      where: { id: conversationId, line: { businessId: access.businessId } },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Conversation not found');
    }
  }

  private async lineOfBusiness(
    access: BusinessAccess,
    lineId: string,
  ): Promise<void> {
    const found = await this.prisma.line.findFirst({
      where: { id: lineId, businessId: access.businessId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Line not found');
    }
  }

  private seq(value: string): bigint {
    const parsed = seqSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException('before and after must be message seqs');
    }
    return BigInt(parsed.data);
  }
}
