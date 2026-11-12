import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { parseOrBadRequest } from '../admin/admin.schemas.js';
import type { SessionUser } from '../auth/auth.service.js';
import {
  BusinessAccessGuard,
  CurrentBusiness,
  type BusinessAccess,
} from '../auth/business-access.guard.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { REPLY_STATUS } from '../inbox/human-replies.service.js';
import {
  chargeBodySchema,
  InboxPaymentsService,
} from './inbox-payments.service.js';

const idSchema = z.uuid();

/** Payments in the inbox (prompt 07c), for the people of the business. */
@Controller('inbox/businesses/:businessId')
@UseGuards(SessionGuard, BusinessAccessGuard)
export class InboxPaymentsController {
  constructor(private readonly payments: InboxPaymentsService) {}

  /**
   * Body `{ amountArs, concept, clientId }`: a charge with the default
   * account, sent as the person's reply. `{ payment, message }` with the
   * reply's statuses (200 sent or replayed, 202 uncertain, 502 rejected by
   * Meta); 409 `WINDOW_CLOSED`, `ALREADY_TAKEN` or `NO_PAYMENT_ACCOUNT` and
   * 502 `PAYMENT_LINK_FAILED` before sending.
   */
  @Post('conversations/:conversationId/payments')
  async charge(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.payments.charge(
      access,
      user,
      id(conversationId, 'conversationId'),
      parseOrBadRequest(chargeBodySchema, body ?? {}, 'body'),
    );
    res.status(REPLY_STATUS[result.message.outcome]);
    return result;
  }

  @Get('conversations/:conversationId/payments')
  list(
    @CurrentBusiness() access: BusinessAccess,
    @Param('conversationId') conversationId: string,
  ) {
    return this.payments.list(access, id(conversationId, 'conversationId'));
  }

  /** "Marcar pagado". */
  @Post('payments/:paymentId/mark-paid')
  @HttpCode(HttpStatus.OK)
  markPaid(
    @CurrentBusiness() access: BusinessAccess,
    @CurrentUser() user: SessionUser,
    @Param('paymentId') paymentId: string,
  ) {
    return this.payments.markPaid(access, user, id(paymentId, 'paymentId'));
  }
}

function id(value: string, name: string): string {
  return parseOrBadRequest(idSchema, value, name);
}
