import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import {
  type BusinessAccess,
  BusinessAccessGuard,
  CurrentBusiness,
} from '../auth/business-access.guard.js';
import { RoleGuard } from '../auth/role.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { LeadsQueryService } from '../leads/leads-query.service.js';

const range = {
  /** Calendar days in the business's zone; `to` is inclusive. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};
const fromNotAfterTo = (r: { from?: string; to?: string }) =>
  !r.from || !r.to || r.from <= r.to;
const listQuerySchema = z
  .object({
    ...range,
    q: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine(fromNotAfterTo, { message: 'from must not be after to' });
const exportQuerySchema = z
  .object(range)
  .strict()
  .refine(fromNotAfterTo, { message: 'from must not be after to' });

/** The business's leads (backoffice), for its OWNERs only. */
@Controller('inbox/businesses/:businessId/leads')
@UseGuards(SessionGuard, BusinessAccessGuard, RoleGuard('OWNER'))
export class LeadsController {
  constructor(private readonly leads: LeadsQueryService) {}

  /** `?from=&to=&q=&cursor=`: 50 per page, newest first. */
  @Get()
  list(@CurrentBusiness() access: BusinessAccess, @Query() query: unknown) {
    return this.leads.list(
      access,
      parseOrBadRequest(listQuerySchema, query, 'query'),
    );
  }

  /** `?from=&to=`: every lead of the range as CSV. */
  @Get('export.csv')
  async exportCsv(
    @CurrentBusiness() access: BusinessAccess,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const range = parseOrBadRequest(exportQuerySchema, query, 'query');
    const csv = await this.leads.exportCsv(access, range);
    const days = [range.from, range.to].filter(Boolean).join('_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leads${days ? `-${days}` : ''}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }
}
