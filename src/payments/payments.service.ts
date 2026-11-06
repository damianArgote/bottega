import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { ContextService } from '../conversations/context.service.js';
import {
  PaymentApprover,
  PaymentProviderKind,
  PaymentStatus,
  Prisma,
  type Payment,
  type PaymentAccount,
  type PaymentPurpose,
} from '../generated/prisma/client.js';
import { enqueueEvent, type EventType } from '../integrations/events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentAccountsService } from './payment-accounts.service.js';
import { MercadoPagoProvider } from './providers/mercadopago.provider.js';
import {
  PaymentProviderError,
  type NotificationRequest,
  type PaymentProvider,
  type ProviderAccount,
} from './providers/payment-provider.js';
import { TransferProvider } from './providers/transfer.provider.js';

export const HANDOFF_REASON_PAYMENT = 'payment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreatePaymentInput {
  conversationId: string;
  amountArs: number;
  concept: string;
  purpose: PaymentPurpose;
  purposeId?: string | null;
  /** Defaults to now + PAYMENT_LINK_TTL_MINUTES. */
  expiresAt?: Date;
  /** A repeated request with the same key gets the same payment. */
  idempotencyKey?: string | null;
  /**
   * Who asks: the bot passes a transfer to a person (only a person confirms
   * it); from the inbox a person already holds the conversation.
   */
  requestedBy: 'bot' | 'person';
}

/** What a notification did, for logs and tests. */
export type NotificationOutcome =
  | 'ignored'
  | 'unknown_payment'
  | 'approved'
  | 'review'
  | 'paid_twice'
  | 'rejected'
  | 'amount_mismatch'
  | 'unchanged';

/** How a payment is shown (inbox, events). */
export function paymentView(payment: Payment) {
  return {
    id: payment.id,
    conversationId: payment.conversationId,
    purpose: payment.purpose,
    purposeId: payment.purposeId,
    concept: payment.concept,
    amountArs: payment.amountArs,
    status: payment.status,
    linkUrl: payment.linkUrl,
    expiresAt: payment.expiresAt,
    approvedAt: payment.approvedAt,
    approvedBy: payment.approvedBy,
    approvedByUserId: payment.approvedByUserId,
    createdAt: payment.createdAt,
  };
}

/** "$5.000": whole pesos, Argentine grouping. */
export function formatArs(amount: number): string {
  return `$${amount.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

/**
 * Charges (prompt 07c). Creating one makes the provider's link (or, for a
 * transfer, the fixed text with the account); only the provider's own
 * record of the payment, looked up after a signed notification, or a person
 * confirms it. Never the model, never the notification's content.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly providers: Record<PaymentProviderKind, PaymentProvider>;
  private created: ((expiresAt: Date) => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountsService,
    private readonly contexts: ContextService,
    private readonly config: AppConfigService,
    mercadoPago: MercadoPagoProvider,
    transfer: TransferProvider,
  ) {
    this.providers = {
      [PaymentProviderKind.mercadopago]: mercadoPago,
      [PaymentProviderKind.transfer]: transfer,
    };
  }

  /** Called with each new charge's expiry (the expiry scheduler). */
  onCreated(listener: (expiresAt: Date) => void): void {
    this.created = listener;
  }

  /**
   * Creates a charge with the business's default account and returns it
   * with the text to send the contact. Idempotent by `idempotencyKey`: a
   * repeated request returns the same payment (and retries a link that
   * failed). 409 `NO_PAYMENT_ACCOUNT` without an active default account;
   * 502 `PAYMENT_LINK_FAILED` when the provider fails (retry it).
   */
  async create(
    input: CreatePaymentInput,
  ): Promise<{ payment: Payment; text: string }> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: input.conversationId },
      select: {
        id: true,
        contactId: true,
        line: { select: { businessId: true } },
      },
    });
    const businessId = conversation.line.businessId;
    const account = await this.prisma.paymentAccount.findFirst({
      where: { businessId, isDefault: true, active: true },
    });
    if (!account) {
      throw new ConflictException({
        message: 'The business has no active default payment account',
        code: 'NO_PAYMENT_ACCOUNT',
      });
    }
    const expiresAt =
      input.expiresAt ??
      new Date(
        Date.now() + this.config.get('PAYMENT_LINK_TTL_MINUTES') * 60_000,
      );

    let payment = await this.insertOnce(input, {
      businessId,
      contactId: conversation.contactId,
      account,
      expiresAt,
    });
    this.created?.(payment.expiresAt);
    // Created before this request (same key): its own account and link.
    const paymentAccount =
      payment.accountId === account.id
        ? account
        : await this.prisma.paymentAccount.findUniqueOrThrow({
            where: { id: payment.accountId },
          });
    const isTransfer = paymentAccount.provider === PaymentProviderKind.transfer;

    if (!isTransfer && !payment.linkUrl) {
      payment = await this.createLink(paymentAccount, payment);
    }
    if (isTransfer && input.requestedBy === 'bot') {
      await this.passToPerson(
        payment.conversationId,
        `Pasó a Pendientes: tiene que pagar por transferencia (${payment.concept}); marcalo pagado cuando llegue`,
      );
    }
    return { payment, text: paymentText(payment, paymentAccount) };
  }

  /**
   * A Mercado Pago notification to `/webhooks/payments/mercadopago/:key`.
   * Answers what it did; throws (so the provider retries) only when the
   * payment could not be looked up. 404 for an unknown key.
   */
  async handleNotification(
    provider: PaymentProviderKind,
    webhookKey: string,
    request: NotificationRequest,
  ): Promise<NotificationOutcome> {
    const account = await this.prisma.paymentAccount.findFirst({
      where: { webhookKey, provider },
    });
    if (!account) {
      throw new NotFoundException('Unknown payment webhook');
    }
    const adapter = this.providers[provider];
    const providerAccount = this.providerAccount(account);
    const providerPaymentId = adapter.verifyNotification(
      providerAccount,
      request,
    );
    if (!providerPaymentId) {
      this.logger.warn(
        `Payment notification for account ${account.id} ignored (bad signature or not a payment)`,
      );
      return 'ignored';
    }
    // A record of what arrived (never processed again from here).
    await this.prisma.webhookEvent.create({
      data: {
        source: provider,
        payload: {
          query: request.query,
          body: request.body ?? null,
        } as Prisma.InputJsonValue,
        processedAt: new Date(),
      },
    });

    let remote;
    try {
      remote = await adapter.fetchPayment(providerAccount, providerPaymentId);
    } catch (error) {
      const code =
        error instanceof PaymentProviderError ? error.code : 'unknown';
      this.logger.warn(
        `Payment ${providerPaymentId} lookup failed for account ${account.id}: ${code}`,
      );
      throw new BadGatewayException({
        message: 'The payment could not be looked up',
        code: 'PAYMENT_LOOKUP_FAILED',
      });
    }
    if (!remote.reference || !UUID.test(remote.reference)) {
      return 'unknown_payment';
    }
    const reference = remote.reference;

    const outcome = await this.prisma.$transaction(async (tx) => {
      const [payment] = await tx.$queryRaw<Payment[]>`
        SELECT id FROM payment
        WHERE id = ${reference}::uuid AND account_id = ${account.id}::uuid
        FOR UPDATE`;
      if (!payment) {
        return 'unknown_payment' as const;
      }
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      return this.apply(tx, current, providerPaymentId, remote);
    });
    this.logger.log(
      `Payment notification ${providerPaymentId} for account ${account.id}: ${outcome}`,
    );
    return outcome;
  }

  private async apply(
    tx: Prisma.TransactionClient,
    payment: Payment,
    providerPaymentId: string,
    remote: Awaited<ReturnType<PaymentProvider['fetchPayment']>>,
  ): Promise<NotificationOutcome> {
    if (remote.status === 'rejected') {
      if (payment.status !== PaymentStatus.PENDING) {
        return 'unchanged';
      }
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.REJECTED },
      });
      return 'rejected';
    }
    if (remote.status !== 'approved') {
      return 'unchanged';
    }
    if (
      remote.amountArs !== payment.amountArs ||
      (remote.currency !== null && remote.currency !== 'ARS')
    ) {
      this.logger.warn(
        `Payment ${payment.id} approved with another amount or currency; not confirmed`,
      );
      return 'amount_mismatch';
    }
    if (payment.providerPaymentId === providerPaymentId) {
      return 'unchanged';
    }
    if (
      payment.status === PaymentStatus.APPROVED ||
      payment.status === PaymentStatus.REVIEW
    ) {
      // Another approved payment for the same charge: paid twice. Never
      // refunded automatically; a person sees it.
      await this.passToPerson(
        payment.conversationId,
        `Pasó a Pendientes: pagó dos veces ${payment.concept}; revisalo`,
        tx,
      );
      return 'paid_twice';
    }
    const approvedAt = remote.approvedAt ?? new Date();
    const late =
      payment.status === PaymentStatus.EXPIRED ||
      approvedAt.getTime() > payment.expiresAt.getTime();
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: late ? PaymentStatus.REVIEW : PaymentStatus.APPROVED,
        providerPaymentId,
        approvedAt,
        approvedBy: PaymentApprover.PROVIDER,
      },
    });
    if (late) {
      await this.passToPerson(
        payment.conversationId,
        `Pasó a Pendientes: pagó ${payment.concept} después del vencimiento; revisalo`,
        tx,
      );
    }
    await this.emit(tx, late ? 'payment.review' : 'payment.approved', updated);
    return late ? 'review' : 'approved';
  }

  /** Enqueues a payment event (in the caller's transaction). */
  async emit(
    tx: Prisma.TransactionClient,
    type: EventType,
    payment: Payment,
  ): Promise<void> {
    await enqueueEvent(tx, {
      conversationId: payment.conversationId,
      type,
      data: { payment: paymentView(payment) },
    });
  }

  /** Opens a handoff unless one is already open (never two for one cause). */
  private async passToPerson(
    conversationId: string,
    systemText: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (t: Prisma.TransactionClient) => {
      const open = await t.handoffRequest.findFirst({
        where: { conversationId, status: 'OPEN' },
        select: { id: true },
      });
      if (!open) {
        await this.contexts.requestHuman(
          conversationId,
          HANDOFF_REASON_PAYMENT,
          t,
          systemText,
        );
      }
    };
    await (tx ? run(tx) : this.prisma.$transaction(run));
  }

  private async insertOnce(
    input: CreatePaymentInput,
    resolved: {
      businessId: string;
      contactId: string;
      account: PaymentAccount;
      expiresAt: Date;
    },
  ): Promise<Payment> {
    const key = input.idempotencyKey ?? null;
    if (key) {
      const existing = await this.prisma.payment.findUnique({
        where: {
          businessId_idempotencyKey: {
            businessId: resolved.businessId,
            idempotencyKey: key,
          },
        },
      });
      if (existing) {
        return existing;
      }
    }
    try {
      return await this.prisma.payment.create({
        data: {
          businessId: resolved.businessId,
          conversationId: input.conversationId,
          contactId: resolved.contactId,
          accountId: resolved.account.id,
          purpose: input.purpose,
          purposeId: input.purposeId ?? null,
          concept: input.concept,
          amountArs: input.amountArs,
          expiresAt: resolved.expiresAt,
          idempotencyKey: key,
        },
      });
    } catch (error) {
      // The same key at the same time: the other request created it.
      if (
        key &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.prisma.payment.findUniqueOrThrow({
          where: {
            businessId_idempotencyKey: {
              businessId: resolved.businessId,
              idempotencyKey: key,
            },
          },
        });
      }
      throw error;
    }
  }

  private async createLink(
    account: PaymentAccount,
    payment: Payment,
  ): Promise<Payment> {
    const notificationUrl = this.accounts.webhookUrl(account.webhookKey);
    if (!notificationUrl) {
      throw new ConflictException({
        message: 'PUBLIC_BASE_URL is needed for payment notifications',
        code: 'NO_PUBLIC_URL',
      });
    }
    try {
      const link = await this.providers[account.provider].createLink(
        this.providerAccount(account),
        {
          id: payment.id,
          concept: payment.concept,
          amountArs: payment.amountArs,
          expiresAt: payment.expiresAt,
          notificationUrl,
        },
      );
      return await this.prisma.payment.update({
        where: { id: payment.id },
        data: { linkUrl: link.url, providerRef: link.providerRef },
      });
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) {
        throw error;
      }
      this.logger.warn(`Payment link for ${payment.id} failed: ${error.code}`);
      throw new BadGatewayException({
        message: 'The payment provider did not create the link',
        code: 'PAYMENT_LINK_FAILED',
      });
    }
  }

  private providerAccount(account: PaymentAccount): ProviderAccount {
    return {
      id: account.id,
      credentials:
        account.provider === PaymentProviderKind.mercadopago
          ? this.accounts.mercadoPagoCredentials(account)
          : null,
    };
  }
}

/** The fixed text the contact gets: the link, or the transfer data. */
export function paymentText(payment: Payment, account: PaymentAccount): string {
  const what = `${payment.concept} (${formatArs(payment.amountArs)})`;
  if (account.provider === PaymentProviderKind.transfer) {
    return [
      `Para pagar ${what}, transferí a:`,
      `Alias/CBU: ${account.transferAlias ?? ''}`,
      `Titular: ${account.transferHolder ?? ''}`,
      'Después mandanos el comprobante por acá.',
    ].join('\n');
  }
  return `Te paso el link para pagar ${what}: ${payment.linkUrl ?? ''}`;
}
