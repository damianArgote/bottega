import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  addOwnerBodySchema,
  businessIdSchema,
  createBusinessBodySchema,
  isEmptyBody,
  lineCredentialsBodySchema,
  lineIdSchema,
  parseOrBadRequest,
  registerNumberBodySchema,
} from '../admin/admin.schemas.js';
import { BusinessesService } from '../admin/businesses.service.js';
import type { SessionUser } from '../auth/auth.service.js';
import { CurrentUser, SessionGuard } from '../auth/session.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { UsersService } from '../auth/users.service.js';
import { LineOnboardingService } from '../onboarding/line-onboarding.service.js';

/**
 * Client onboarding for the BotSuite46 team from the inbox: the same
 * services and validation as the admin API, behind a staff session instead
 * of the admin key. Never gives access to conversations, messages or leads.
 * Every action is logged with who did it (ids only, never bodies).
 */
@Controller('staff')
@UseGuards(SessionGuard, StaffGuard)
export class StaffController {
  private readonly logger = new Logger(StaffController.name);

  constructor(
    private readonly businesses: BusinessesService,
    private readonly onboarding: LineOnboardingService,
    private readonly users: UsersService,
  ) {}

  @Get('lines/status')
  linesStatus() {
    return this.onboarding.allStatus();
  }

  @Post('businesses')
  @HttpCode(HttpStatus.CREATED)
  async createBusiness(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    const business = await this.businesses.createBusiness(
      parseOrBadRequest(createBusinessBodySchema, body ?? {}, 'body'),
    );
    this.audit(user, 'created business', business.id);
    return business;
  }

  /** Draft lines only: the rest is loaded step by step. */
  @Post('businesses/:businessId/lines')
  @HttpCode(HttpStatus.CREATED)
  async createDraftLine(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    if (!isEmptyBody(body)) {
      throw new BadRequestException(
        'Staff routes create draft lines only: send no body',
      );
    }
    const draft = await this.businesses.createDraftLine(
      parseOrBadRequest(businessIdSchema, businessId, 'businessId'),
    );
    this.audit(user, 'created draft line', draft.line.id);
    return draft;
  }

  @Put('lines/:lineId/credentials')
  async setCredentials(
    @CurrentUser() user: SessionUser,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    const id = parseOrBadRequest(lineIdSchema, lineId, 'lineId');
    const result = await this.onboarding.setCredentials(
      id,
      parseOrBadRequest(lineCredentialsBodySchema, body ?? {}, 'body'),
    );
    this.audit(user, 'stored credentials of line', id);
    return result;
  }

  @Get('lines/:lineId/phone-numbers')
  phoneNumbers(@Param('lineId') lineId: string) {
    return this.onboarding.phoneNumbers(
      parseOrBadRequest(lineIdSchema, lineId, 'lineId'),
    );
  }

  @Post('lines/:lineId/register')
  @HttpCode(HttpStatus.OK)
  async register(
    @CurrentUser() user: SessionUser,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    const id = parseOrBadRequest(lineIdSchema, lineId, 'lineId');
    const result = await this.onboarding.register(
      id,
      parseOrBadRequest(registerNumberBodySchema, body ?? {}, 'body'),
    );
    this.audit(user, 'registered the number of line', id);
    return result;
  }

  @Post('lines/:lineId/subscribe')
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @CurrentUser() user: SessionUser,
    @Param('lineId') lineId: string,
  ) {
    const id = parseOrBadRequest(lineIdSchema, lineId, 'lineId');
    const result = await this.onboarding.subscribe(id);
    this.audit(user, 'subscribed the app of line', id);
    return result;
  }

  @Post('lines/:lineId/app-published')
  @HttpCode(HttpStatus.OK)
  async markAppPublished(
    @CurrentUser() user: SessionUser,
    @Param('lineId') lineId: string,
  ) {
    const id = parseOrBadRequest(lineIdSchema, lineId, 'lineId');
    const result = await this.onboarding.markAppPublished(id);
    this.audit(user, 'marked the app published for line', id);
    return result;
  }

  /**
   * `{ email, name }`: a NEW account as OWNER, with a temporary password
   * shown once. An existing email is refused (409 `EMAIL_IN_USE`): staff
   * could otherwise attach themselves or any account to any business.
   */
  @Post('businesses/:businessId/owners')
  @HttpCode(HttpStatus.CREATED)
  async addOwner(
    @CurrentUser() user: SessionUser,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const id = parseOrBadRequest(businessIdSchema, businessId, 'businessId');
    const result = await this.users.addMember(
      id,
      {
        ...parseOrBadRequest(addOwnerBodySchema, body ?? {}, 'body'),
        role: 'OWNER',
      },
      { newUserOnly: true },
    );
    this.audit(user, `added owner ${result.user.id} to business`, id);
    return result;
  }

  private audit(user: SessionUser, action: string, targetId: string): void {
    this.logger.log(`Staff user ${user.id} ${action} ${targetId}`);
  }
}
