import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CredentialsDecryptError } from '../lines/credentials-cipher.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { lineView } from '../lines/line-view.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../prisma/sql.js';
import {
  type GraphFailure,
  GraphOnboardingClient,
  type PhoneNumberInfo,
} from '../whatsapp/graph-onboarding.client.js';
import { GraphWhatsAppClient } from '../whatsapp/graph-whatsapp.client.js';
import { onboardingErrorMessage } from '../whatsapp/meta-errors.js';
import { onboardingStep, pendingSteps } from './onboarding-status.js';

export interface RegisterInput {
  phoneNumberId: string;
  /** Two-step PIN of the number: sent to Meta, never stored or logged. */
  pin: string;
}

export interface LineCredentialsInput {
  wabaId: string;
  appId: string;
  appSecret: string;
  accessToken: string;
}

/** Meta lookups of the status are reused this long, per line. */
const META_CACHE_MS = 60_000;

/** What Meta says about a line; null fields could not be asked. */
interface MetaSnapshot {
  number: PhoneNumberInfo | null;
  appSubscribed: boolean | null;
  otherApps: boolean | null;
  /** Text for the user when a lookup failed. */
  metaError: string | null;
}

const NO_META: MetaSnapshot = {
  number: null,
  appSubscribed: null,
  otherApps: null,
  metaError: null,
};

const statusSelect = {
  id: true,
  phoneNumberId: true,
  wabaId: true,
  appId: true,
  displayPhone: true,
  accessTokenEncrypted: true,
  appPublishedAt: true,
} as const;

type StatusLine = {
  id: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  appId: string | null;
  displayPhone: string | null;
  accessTokenEncrypted: string | null;
  appPublishedAt: Date | null;
};

const NUMBER_NOT_IN_WABA =
  'Ese número no es de la cuenta de WhatsApp de esta línea. Elegilo de la lista de números.';

const NUMBER_NOT_IN_WABA_CREDENTIALS =
  'El número de esta línea no está en esa cuenta de WhatsApp. Revisá el WABA ID.';

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
  private readonly metaCache = new Map<
    string,
    { expiresAt: number; value: MetaSnapshot }
  >();
  /**
   * Bumped on every change to a line, so a status lookup that started before
   * the change does not cache what Meta said about the old values.
   */
  private readonly metaGeneration = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly meta: GraphOnboardingClient,
    private readonly graph: GraphWhatsAppClient,
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
    // A line that already has a number (the seeded default line has no
    // WABA stored) only accepts the WhatsApp account that holds it.
    if (line.phoneNumberId) {
      const numbers = await this.meta.phoneNumbers(
        input.wabaId,
        input.accessToken,
      );
      if (!numbers.ok) {
        throw metaError(numbers.error);
      }
      if (!numbers.data.some((n) => n.id === line.phoneNumberId)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: NUMBER_NOT_IN_WABA_CREDENTIALS,
        });
      }
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
    this.invalidateMeta(line.id);
    return { line: updated, wabaName: waba.data.name };
  }

  /** The numbers of the line's WhatsApp account, to pick one to register. */
  async phoneNumbers(lineId: string) {
    const { wabaId, token } = await this.metaAccess(lineId);
    const numbers = await this.meta.phoneNumbers(wabaId, token);
    if (!numbers.ok) {
      throw metaError(numbers.error);
    }
    return { phoneNumbers: numbers.data };
  }

  /**
   * Registers a number of the line's WhatsApp account with its two-step PIN
   * and binds it to the line. The number must be in that account (never
   * guessed: the caller picks it from {@link phoneNumbers}).
   */
  async register(lineId: string, input: RegisterInput) {
    const { line, wabaId, token } = await this.metaAccess(lineId);
    if (line.phoneNumberId && line.phoneNumberId !== input.phoneNumberId) {
      throw new ConflictException('This line already has another number');
    }
    const owner = await this.prisma.line.findUnique({
      where: { phoneNumberId: input.phoneNumberId },
      select: { id: true },
    });
    if (owner && owner.id !== line.id) {
      throw new ConflictException('This phone number id already has a line');
    }

    const numbers = await this.meta.phoneNumbers(wabaId, token);
    if (!numbers.ok) {
      throw metaError(numbers.error);
    }
    const number = numbers.data.find((n) => n.id === input.phoneNumberId);
    if (!number) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: NUMBER_NOT_IN_WABA,
      });
    }
    const registered = await this.meta.register(
      input.phoneNumberId,
      input.pin,
      token,
    );
    if (!registered.ok) {
      throw metaError(registered.error);
    }

    try {
      const updated = await this.prisma.line.update({
        where: { id: line.id },
        data: {
          phoneNumberId: input.phoneNumberId,
          displayPhone: number.displayPhoneNumber,
        },
        select: lineView,
      });
      this.logger.log(`Phone number registered for line ${line.id}`);
      this.invalidateMeta(line.id);
      return { line: updated };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This phone number id already has a line');
      }
      throw error;
    }
  }

  /**
   * Subscribes the line's app to its WhatsApp account and reads the
   * subscriptions back: another app there means two bots would answer.
   */
  async subscribe(lineId: string) {
    const { line, wabaId, token } = await this.metaAccess(lineId);
    const outcome = await this.graph.subscribeApp(wabaId, token);
    if (!outcome.subscribed) {
      throw metaError({
        code: typeof outcome.code === 'number' ? outcome.code : 'network_error',
        subcode: null,
        httpStatus: null,
        message: outcome.message,
      });
    }
    const apps = await this.meta.subscribedApps(wabaId, token);
    if (!apps.ok) {
      throw metaError(apps.error);
    }
    this.logger.log(`App subscribed for line ${line.id}`);
    this.invalidateMeta(line.id);
    // Without a known app id (the seeded default line), any second app is
    // another one.
    const otherApps = line.appId
      ? apps.data.some((app) => app.id !== line.appId)
      : apps.data.length > 1;
    return { subscribed: true, apps: apps.data, otherApps };
  }

  /** The team confirmed the Meta app is Live; the first confirmation stays. */
  async markAppPublished(lineId: string) {
    const line = await this.findLine(lineId);
    if (!line.appPublishedAt) {
      await this.prisma.line.updateMany({
        where: { id: line.id, appPublishedAt: null },
        data: { appPublishedAt: new Date() },
      });
    }
    const { appPublishedAt } = await this.prisma.line.findUniqueOrThrow({
      where: { id: line.id },
      select: { appPublishedAt: true },
    });
    return { appPublishedAt };
  }

  /** One line's connection state (404 outside `businessId` when given). */
  async status(lineId: string, businessId?: string) {
    const line = await this.prisma.line.findFirst({
      where: { id: lineId, ...(businessId ? { businessId } : {}) },
      select: statusSelect,
    });
    if (!line) {
      throw new NotFoundException('Line not found');
    }
    return this.statusOf(line);
  }

  /** The connection state of every line of the business, drafts included. */
  async businessStatus(businessId: string) {
    const lines = await this.prisma.line.findMany({
      where: { businessId },
      orderBy: { createdAt: 'asc' },
      select: statusSelect,
    });
    return { lines: await Promise.all(lines.map((l) => this.statusOf(l))) };
  }

  /** Never includes secrets, the verify token or the webhook key. */
  private async statusOf(line: StatusLine) {
    const step = onboardingStep(line);
    const [meta, inbound] = await Promise.all([
      this.metaSnapshot(line),
      this.prisma.conversation.aggregate({
        where: { lineId: line.id },
        _max: { lastInboundAt: true },
      }),
    ]);
    const lastInboundAt = inbound._max.lastInboundAt;
    return {
      lineId: line.id,
      step,
      phoneNumberId: line.phoneNumberId,
      displayPhone: line.displayPhone,
      appPublishedAt: line.appPublishedAt,
      lastInboundAt,
      ...meta,
      pending: pendingSteps({
        step,
        appSubscribed: meta.appSubscribed,
        appPublishedAt: line.appPublishedAt,
        lastInboundAt,
      }),
    };
  }

  private async metaSnapshot(line: StatusLine): Promise<MetaSnapshot> {
    if (!line.wabaId || !line.accessTokenEncrypted) {
      return NO_META;
    }
    const cached = this.metaCache.get(line.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const generation = this.metaGeneration.get(line.id) ?? 0;
    let token: string;
    try {
      token = this.credentials.decrypt(line.accessTokenEncrypted);
    } catch (error) {
      if (!(error instanceof CredentialsDecryptError)) {
        throw error;
      }
      return {
        ...NO_META,
        metaError:
          'No pudimos leer el token guardado. Hay que cargar las credenciales de nuevo.',
      };
    }
    const [number, apps] = await Promise.all([
      line.phoneNumberId
        ? this.meta.phoneNumber(line.phoneNumberId, token)
        : null,
      this.meta.subscribedApps(line.wabaId, token),
    ]);
    const failure =
      (number && !number.ok ? number.error : null) ??
      (!apps.ok ? apps.error : null);
    const value: MetaSnapshot = {
      number: number?.ok ? number.data : null,
      appSubscribed: apps.ok
        ? apps.data.some((app) => !line.appId || app.id === line.appId)
        : null,
      otherApps: apps.ok
        ? line.appId
          ? apps.data.some((app) => app.id !== line.appId)
          : apps.data.length > 1
        : null,
      metaError: failure ? onboardingErrorMessage(failure) : null,
    };
    // A failed lookup is asked again next time instead of being cached, and
    // so is one that raced with a change to the line.
    if (!failure && (this.metaGeneration.get(line.id) ?? 0) === generation) {
      this.metaCache.set(line.id, {
        expiresAt: Date.now() + META_CACHE_MS,
        value,
      });
    }
    return value;
  }

  private invalidateMeta(lineId: string): void {
    this.metaGeneration.set(lineId, (this.metaGeneration.get(lineId) ?? 0) + 1);
    this.metaCache.delete(lineId);
  }

  /** The line with its WhatsApp account and decrypted token (409 without). */
  private async metaAccess(lineId: string, businessId?: string) {
    const line = await this.findLine(lineId, businessId);
    if (!line.wabaId || !line.accessTokenEncrypted) {
      throw new ConflictException('Load the line credentials first');
    }
    let token: string;
    try {
      token = this.credentials.decrypt(line.accessTokenEncrypted);
    } catch (error) {
      if (error instanceof CredentialsDecryptError) {
        throw new ConflictException(
          'The line token cannot be decrypted: load the credentials again',
        );
      }
      throw error;
    }
    return { line, wabaId: line.wabaId, token };
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
