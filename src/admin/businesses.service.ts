import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { newVerifyToken, newWebhookKey } from '../lines/default-line.seed.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../prisma/sql.js';
import {
  GraphWhatsAppClient,
  type SubscribeOutcome,
} from '../whatsapp/graph-whatsapp.client.js';

export interface CreateBusinessInput {
  name: string;
  slug: string;
  botName: string;
}

export interface CreateLineInput {
  phoneNumberId: string;
  wabaId: string;
  appId: string;
  appSecret: string;
  accessToken: string;
  displayPhone?: string;
}

/** Public view of a line: never includes secrets. */
const lineView = {
  id: true,
  businessId: true,
  phoneNumberId: true,
  wabaId: true,
  appId: true,
  displayPhone: true,
  active: true,
  createdAt: true,
} as const;

/**
 * Onboards businesses and their lines (admin API). Each line brings its own
 * Meta app: its secret and System User token are stored encrypted and never
 * returned.
 */
@Injectable()
export class BusinessesService {
  private readonly logger = new Logger(BusinessesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly graph: GraphWhatsAppClient,
    private readonly config: AppConfigService,
  ) {}

  async createBusiness(input: CreateBusinessInput) {
    try {
      return await this.prisma.business.create({
        data: input,
        select: {
          id: true,
          name: true,
          slug: true,
          botName: true,
          createdAt: true,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A business with this slug already exists');
      }
      throw error;
    }
  }

  /**
   * Creates the line and subscribes its Meta app to the WhatsApp account's
   * events. A failed subscription does not undo the line: the result says so
   * and the subscription can be done by hand in the Meta App Dashboard.
   */
  async createLine(businessId: string, input: CreateLineInput) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }

    let line;
    try {
      line = await this.prisma.line.create({
        data: {
          businessId,
          phoneNumberId: input.phoneNumberId,
          wabaId: input.wabaId,
          appId: input.appId,
          displayPhone: input.displayPhone ?? null,
          appSecretEncrypted: this.credentials.encrypt(input.appSecret),
          accessTokenEncrypted: this.credentials.encrypt(input.accessToken),
          verifyToken: newVerifyToken(),
          webhookKey: newWebhookKey(),
        },
        select: { ...lineView, verifyToken: true, webhookKey: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This phone number id already has a line');
      }
      throw error;
    }

    const subscription: SubscribeOutcome = await this.graph.subscribeApp(
      input.wabaId,
      input.accessToken,
    );
    this.logger.log(
      `Line ${line.id} created for business ${businessId} (app subscribed: ${subscription.subscribed})`,
    );

    const { verifyToken, webhookKey, ...view } = line;
    const webhookPath = `/webhooks/whatsapp/${webhookKey}`;
    const baseUrl =
      this.config.get('PUBLIC_BASE_URL') ??
      this.config.get('RENDER_EXTERNAL_URL');
    return {
      line: view,
      webhookUrl: baseUrl ? `${baseUrl}${webhookPath}` : null,
      webhookPath,
      verifyToken,
      subscription,
    };
  }
}
