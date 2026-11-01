import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';

const PAGE_SIZE = 100;

export const readQuerySchema = z
  .object({
    /** Only rows changed after this moment (ISO 8601). */
    updatedSince: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();

type ReadQuery = z.infer<typeof readQuerySchema>;

interface Cursor {
  updatedAt: Date;
  id: string;
}

/**
 * The read-only integrations API (/integrations/v1) of one business:
 * leads and conversations with their state, never messages (not even the
 * last message preview). Pages of 100 by (updatedAt, id), oldest change
 * first, so a flow can poll with the last `nextCursor` (or `updatedSince`).
 */
@Injectable()
export class IntegrationsReadService {
  constructor(private readonly prisma: PrismaService) {}

  async leads(businessId: string, query: ReadQuery) {
    const rows = await this.prisma.lead.findMany({
      where: { businessId, ...this.window(query) },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        status: true,
        data: true,
        createdAt: true,
        updatedAt: true,
        conversation: {
          select: {
            id: true,
            lineId: true,
            contact: { select: { waId: true, name: true, profileName: true } },
          },
        },
      },
    });
    return page(rows, ({ conversation, ...lead }) => ({
      ...lead,
      conversation: { id: conversation.id, lineId: conversation.lineId },
      contact: contactView(conversation.contact),
    }));
  }

  async conversations(businessId: string, query: ReadQuery) {
    const rows = await this.prisma.conversation.findMany({
      where: { line: { businessId }, ...this.window(query) },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        lineId: true,
        status: true,
        paused: true,
        unreadCount: true,
        lastMessageAt: true,
        windowExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        assignedTo: { select: { id: true, name: true } },
        contact: { select: { waId: true, name: true, profileName: true } },
      },
    });
    return page(rows, ({ contact, ...conversation }) => ({
      ...conversation,
      contact: contactView(contact),
    }));
  }

  /** Rows after the cursor, else changed after `updatedSince`. */
  private window(query: ReadQuery) {
    if (query.cursor) {
      const { updatedAt, id } = decodeCursor(query.cursor);
      return {
        OR: [{ updatedAt: { gt: updatedAt } }, { updatedAt, id: { gt: id } }],
      };
    }
    return query.updatedSince
      ? { updatedAt: { gt: new Date(query.updatedSince) } }
      : {};
  }
}

function page<T extends { id: string; updatedAt: Date }, V>(
  rows: T[],
  view: (row: T) => V,
): { data: V[]; nextCursor: string | null } {
  const hasMore = rows.length > PAGE_SIZE;
  const shown = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = shown.at(-1);
  return {
    data: shown.map(view),
    // Also without more rows: the next poll starts after the last one seen.
    nextCursor: last
      ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
      : null,
  };
}

function contactView(contact: {
  waId: string;
  name: string | null;
  profileName: string | null;
}) {
  return { waId: contact.waId, name: contact.name ?? contact.profileName };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ u: cursor.updatedAt.toISOString(), i: cursor.id }),
  ).toString('base64url');
}

const cursorSchema = z.object({ u: z.iso.datetime(), i: z.uuid() });

function decodeCursor(value: string): Cursor {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return { updatedAt: new Date(parsed.u), id: parsed.i };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
