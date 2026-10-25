import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { leadFieldSchema } from '../agents/agent-profile.schema.js';
import type { BusinessAccess } from '../auth/business-access.guard.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { leadsCsv } from './leads-csv.js';

export const LEADS_PAGE_SIZE = 50;
/** Rows read per query while exporting. */
const EXPORT_BATCH = 500;

/** `from` and `to` are calendar days in the business's zone, inclusive. */
export interface LeadsFilter {
  from?: string;
  to?: string;
  /** Contact name, profile name or number, or any lead value. */
  q?: string;
}

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

/** `q` as a literal ILIKE pattern (its % _ and \ match themselves). */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** created_at is stored as UTC without a zone; cursors carry it as ISO. */
const sqlTimestamp = (iso: string) => iso.replace(/Z$/, '');

const leadSelect = {
  id: true,
  status: true,
  data: true,
  createdAt: true,
  updatedAt: true,
  conversation: {
    select: {
      id: true,
      lineId: true,
      status: true,
      contact: {
        select: { id: true, waId: true, profileName: true, name: true },
      },
    },
  },
} satisfies Prisma.LeadSelect;

/** The leads of one business (backoffice), newest first. */
@Injectable()
export class LeadsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** One page by (createdAt, id) descending, with contact and conversation. */
  async list(
    access: BusinessAccess,
    filter: LeadsFilter & { cursor?: string },
  ) {
    const after = filter.cursor ? decodeCursor(filter.cursor) : null;
    const ids = await this.pageIds(
      access.businessId,
      filter,
      after,
      LEADS_PAGE_SIZE + 1,
    );
    const page = ids.slice(0, LEADS_PAGE_SIZE);
    const rows = await this.prisma.lead.findMany({
      where: { id: { in: page.map((r) => r.id) } },
      select: leadSelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const leads = page.map((r) => {
      const { conversation, ...lead } = byId.get(r.id)!;
      const { contact, ...rest } = conversation;
      return { ...lead, contact, conversation: rest };
    });
    const last = page.at(-1);
    return {
      leads,
      nextCursor:
        ids.length > LEADS_PAGE_SIZE && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** Every lead of the range (newest first) as CSV, with the business's fields. */
  async exportCsv(
    access: BusinessAccess,
    filter: Pick<LeadsFilter, 'from' | 'to'>,
  ): Promise<string> {
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: access.businessId },
      select: {
        timezone: true,
        agentProfile: { select: { leadFields: true } },
      },
    });
    const fields = z
      .array(leadFieldSchema)
      .catch([])
      .parse(business.agentProfile?.leadFields ?? []);

    const rows: Parameters<typeof leadsCsv>[1][number][] = [];
    let after: Cursor | null = null;
    for (;;) {
      const ids = await this.pageIds(
        access.businessId,
        filter,
        after,
        EXPORT_BATCH,
      );
      if (ids.length === 0) {
        break;
      }
      const batch = await this.prisma.lead.findMany({
        where: { id: { in: ids.map((r) => r.id) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          createdAt: true,
          data: true,
          conversation: {
            select: { contact: { select: { waId: true, profileName: true } } },
          },
        },
      });
      rows.push(
        ...batch.map((lead) => ({
          createdAt: lead.createdAt,
          data: (lead.data ?? {}) as Record<string, unknown>,
          ...lead.conversation.contact,
        })),
      );
      const last = ids.at(-1)!;
      after = { at: last.createdAt.toISOString(), id: last.id };
      if (ids.length < EXPORT_BATCH) {
        break;
      }
    }
    return leadsCsv(fields, rows, business.timezone);
  }

  /**
   * Ids of the business's leads that match, after the cursor, newest first.
   * Days are converted with the business's zone in SQL.
   */
  private pageIds(
    businessId: string,
    filter: LeadsFilter,
    after: Cursor | null,
    limit: number,
  ): Promise<{ id: string; createdAt: Date }[]> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`l.business_id = ${businessId}::uuid`,
    ];
    if (filter.from) {
      conditions.push(
        Prisma.sql`l.created_at >= ((${filter.from}::date)::timestamp AT TIME ZONE b.timezone) AT TIME ZONE 'UTC'`,
      );
    }
    if (filter.to) {
      conditions.push(
        Prisma.sql`l.created_at < ((${filter.to}::date + 1)::timestamp AT TIME ZONE b.timezone) AT TIME ZONE 'UTC'`,
      );
    }
    if (filter.q) {
      const pattern = containsPattern(filter.q);
      conditions.push(Prisma.sql`(
        ct.profile_name ILIKE ${pattern} OR ct.name ILIKE ${pattern}
        OR ct.wa_id ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(
            CASE WHEN jsonb_typeof(l.data) = 'object' THEN l.data ELSE '{}'::jsonb END
          ) v WHERE v.value ILIKE ${pattern}
        ))`);
    }
    if (after) {
      conditions.push(
        Prisma.sql`(l.created_at, l.id) < (${sqlTimestamp(after.at)}::timestamp, ${after.id}::uuid)`,
      );
    }
    return this.prisma.$queryRaw<{ id: string; createdAt: Date }[]>`
      SELECT l.id, l.created_at AS "createdAt"
      FROM lead l
      JOIN business b ON b.id = l.business_id
      JOIN conversation c ON c.id = l.conversation_id
      JOIN contact ct ON ct.id = c.contact_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${limit}`;
  }
}
