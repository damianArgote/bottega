import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { lineView } from '../lines/line-view.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type GraphFailure,
  GraphOnboardingClient,
} from '../whatsapp/graph-onboarding.client.js';
import { onboardingErrorMessage } from '../whatsapp/meta-errors.js';

export interface LineCredentialsInput {
  wabaId: string;
  appId: string;
  appSecret: string;
  accessToken: string;
}

const APP_SECRET_MISMATCH =
  'El App ID o el App Secret no son válidos. Copialos de nuevo desde Configuración de la app → Básica.';

/**
 * A Meta failure as an HTTP error: 502 when Meta could not be reached, 400
 * otherwise, with a text for the user and Meta's code (never the request).
 */
export function metaError(error: GraphFailure, message?: string): Error {
  if (error.code === 'network_error') {
    return new BadGatewayException({
      statusCode: 502,
      error: 'Bad Gateway',
      message: onboardingErrorMessage(error),
      metaCode: error.code,
    });
  }
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: message ?? onboardingErrorMessage(error),
    metaCode: error.code,
  });
}

/**
 * Onboards a line step by step with Meta (credentials, number, app
 * subscription), using the line's own encrypted token. Secrets and the PIN
 * are never returned or logged.
 */
@Injectable()
export class LineOnboardingService {
  private readonly logger = new Logger(LineOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly meta: GraphOnboardingClient,
  ) {}

  /**
   * Checks the credentials with Meta (the token sees the WhatsApp account,
   * the app secret belongs to the app) and only then stores them encrypted.
   * `businessId` scopes the line to one business (inbox routes).
   */
  async setCredentials(
    lineId: string,
    input: LineCredentialsInput,
    businessId?: string,
  ) {
    const line = await this.findLine(lineId, businessId);
    if (line.phoneNumberId && line.wabaId && line.wabaId !== input.wabaId) {
      throw new ConflictException(
        'This line already has a number in another WhatsApp account',
      );
    }

    const waba = await this.meta.waba(input.wabaId, input.accessToken);
    if (!waba.ok) {
      throw metaError(waba.error);
    }
    const app = await this.meta.app(input.appId, input.appSecret);
    if (!app.ok) {
      throw metaError(app.error, APP_SECRET_MISMATCH);
    }

    const updated = await this.prisma.line.update({
      where: { id: line.id },
      data: {
        wabaId: input.wabaId,
        appId: input.appId,
        appSecretEncrypted: this.credentials.encrypt(input.appSecret),
        accessTokenEncrypted: this.credentials.encrypt(input.accessToken),
      },
      select: lineView,
    });
    this.logger.log(`Credentials stored for line ${line.id}`);
    return { line: updated, wabaName: waba.data.name };
  }

  private async findLine(lineId: string, businessId?: string) {
    const line = await this.prisma.line.findFirst({
      where: { id: lineId, ...(businessId ? { businessId } : {}) },
      select: {
        id: true,
        businessId: true,
        phoneNumberId: true,
        wabaId: true,
        appId: true,
        accessTokenEncrypted: true,
        appPublishedAt: true,
      },
    });
    if (!line) {
      throw new NotFoundException('Line not found');
    }
    return line;
  }
}
