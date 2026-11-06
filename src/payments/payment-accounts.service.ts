import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../config/app-config.service.js';
import {
  PaymentProviderKind,
  type PaymentAccount,
  type Prisma,
} from '../generated/prisma/client.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Mercado Pago credentials, stored encrypted as JSON. */
export interface MercadoPagoCredentials {
  accessToken: string;
  webhookSecret: string;
}

const label = z.string().trim().min(1).max(80);
const secret = z.string().trim().min(8).max(500);
const alias = z.string().trim().min(1).max(80);
const holder = z.string().trim().min(1).max(120);

export const createAccountSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('mercadopago'),
      label,
      accessToken: secret,
      webhookSecret: secret,
      isDefault: z.boolean().optional(),
      active: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      provider: z.literal('transfer'),
      label,
      /** Alias or CBU. */
      alias,
      holder,
      isDefault: z.boolean().optional(),
      active: z.boolean().default(true),
    })
    .strict(),
]);
export const updateAccountSchema = z
  .object({
    label: label.optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    accessToken: secret.optional(),
    webhookSecret: secret.optional(),
    alias: alias.optional(),
    holder: holder.optional(),
  })
  .strict();

/** The provider's notification route of an account (Mercado Pago only). */
export const mercadoPagoWebhookPath = (webhookKey: string) =>
  `/webhooks/payments/mercadopago/${webhookKey}`;

/**
 * A business's payment accounts (prompt 07c), for the admin API and the
 * staff routes. Credentials are encrypted and never returned: who loads
 * them already has them. Every call is scoped to the business (404).
 */
@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LineCredentialsService,
    private readonly config: AppConfigService,
  ) {}

  async list(businessId: string) {
    await this.business(businessId);
    const accounts = await this.prisma.paymentAccount.findMany({
      where: { businessId },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((account) => this.view(account));
  }

  /**
   * A new account. With `isDefault` unset, it becomes the default when the
   * business has no active default yet.
   */
  async create(businessId: string, input: z.infer<typeof createAccountSchema>) {
    await this.business(businessId);
    const account = await this.prisma.$transaction(async (tx) => {
      const isDefault =
        input.active &&
        (input.isDefault ??
          !(await tx.paymentAccount.findFirst({
            where: { businessId, isDefault: true, active: true },
            select: { id: true },
          })));
      if (isDefault) {
        await clearDefault(tx, businessId);
      }
      return tx.paymentAccount.create({
        data: {
          businessId,
          provider: PaymentProviderKind[input.provider],
          label: input.label,
          webhookKey: randomBytes(24).toString('base64url'),
          isDefault,
          active: input.active,
          ...(input.provider === 'mercadopago'
            ? {
                credentialsEncrypted: this.encrypt({
                  accessToken: input.accessToken,
                  webhookSecret: input.webhookSecret,
                }),
              }
            : { transferAlias: input.alias, transferHolder: input.holder }),
        },
      });
    });
    return this.view(account);
  }

  async update(
    businessId: string,
    accountId: string,
    input: z.infer<typeof updateAccountSchema>,
  ) {
    const current = await this.account(businessId, accountId);
    const isMercadoPago = current.provider === PaymentProviderKind.mercadopago;
    if (
      (isMercadoPago && (input.alias ?? input.holder) !== undefined) ||
      (!isMercadoPago &&
        (input.accessToken ?? input.webhookSecret) !== undefined)
    ) {
      throw new ConflictException({
        message: 'Those fields are not of this account provider',
        code: 'WRONG_PROVIDER_FIELDS',
      });
    }
    const active = input.active ?? current.active;
    const isDefault = active && (input.isDefault ?? current.isDefault);
    const account = await this.prisma.$transaction(async (tx) => {
      if (isDefault && !current.isDefault) {
        await clearDefault(tx, businessId);
      }
      return tx.paymentAccount.update({
        where: { id: accountId },
        data: {
          label: input.label,
          active,
          isDefault,
          transferAlias: input.alias,
          transferHolder: input.holder,
          ...(input.accessToken !== undefined ||
          input.webhookSecret !== undefined
            ? {
                credentialsEncrypted: this.encrypt({
                  ...this.mercadoPagoCredentials(current),
                  ...(input.accessToken !== undefined
                    ? { accessToken: input.accessToken }
                    : {}),
                  ...(input.webhookSecret !== undefined
                    ? { webhookSecret: input.webhookSecret }
                    : {}),
                }),
              }
            : {}),
        },
      });
    });
    return this.view(account);
  }

  /** Only an account no payment used; otherwise deactivate it. */
  async delete(businessId: string, accountId: string) {
    await this.account(businessId, accountId);
    const used = await this.prisma.payment.findFirst({
      where: { accountId },
      select: { id: true },
    });
    if (used) {
      throw new ConflictException({
        message: 'The account has payments; deactivate it instead',
        code: 'ACCOUNT_IN_USE',
      });
    }
    await this.prisma.paymentAccount.delete({ where: { id: accountId } });
  }

  /** The decrypted Mercado Pago credentials of an account. */
  mercadoPagoCredentials(account: PaymentAccount): MercadoPagoCredentials {
    if (!account.credentialsEncrypted) {
      throw new Error(`Payment account ${account.id} has no credentials`);
    }
    return JSON.parse(
      this.credentials.decrypt(account.credentialsEncrypted),
    ) as MercadoPagoCredentials;
  }

  /** The account's provider notification URL; null without a public base. */
  webhookUrl(webhookKey: string): string | null {
    const baseUrl =
      this.config.get('PUBLIC_BASE_URL') ??
      this.config.get('RENDER_EXTERNAL_URL');
    return baseUrl ? `${baseUrl}${mercadoPagoWebhookPath(webhookKey)}` : null;
  }

  /** How an account is shown: never its credentials. */
  private view(account: PaymentAccount) {
    const isMercadoPago = account.provider === PaymentProviderKind.mercadopago;
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      isDefault: account.isDefault,
      active: account.active,
      transfer: isMercadoPago
        ? null
        : { alias: account.transferAlias, holder: account.transferHolder },
      ...(isMercadoPago
        ? {
            webhookPath: mercadoPagoWebhookPath(account.webhookKey),
            webhookUrl: this.webhookUrl(account.webhookKey),
          }
        : { webhookPath: null, webhookUrl: null }),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  private encrypt(credentials: MercadoPagoCredentials): string {
    return this.credentials.encrypt(JSON.stringify(credentials));
  }

  private async business(businessId: string): Promise<void> {
    const found = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Business not found');
    }
  }

  private async account(businessId: string, accountId: string) {
    const found = await this.prisma.paymentAccount.findFirst({
      where: { id: accountId, businessId },
    });
    if (!found) {
      throw new NotFoundException('Payment account not found');
    }
    return found;
  }
}

async function clearDefault(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<void> {
  await tx.paymentAccount.updateMany({
    where: { businessId, isDefault: true },
    data: { isDefault: false },
  });
}
