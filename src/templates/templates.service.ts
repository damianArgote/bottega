import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { CredentialsDecryptError } from '../lines/credentials-cipher.js';
import { LineCredentialsService } from '../lines/line-credentials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  GraphOnboardingClient,
  type MetaTemplate,
} from '../whatsapp/graph-onboarding.client.js';
import { templateVariables, unsupportedReason } from './template-render.js';

/** How often each business's templates are read again from Meta. */
export const TEMPLATE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AccountSyncResult {
  wabaId: string;
  /** Templates Meta returned (and that were upserted). */
  synced: number;
  /** Templates marked deleted because Meta no longer returns them. */
  deleted: number;
  /** Null when it worked; otherwise e.g. `meta_190`, `network_error`. */
  error: string | null;
}

export interface TemplatesSyncResult {
  syncedAt: Date;
  accounts: AccountSyncResult[];
}

const templateSelect = {
  id: true,
  wabaId: true,
  name: true,
  language: true,
  category: true,
  status: true,
  components: true,
} satisfies Prisma.TemplateSelect;

/**
 * A business's message templates: copied from Meta (they are created and
 * approved there), listed for the inbox composer.
 */
@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphOnboardingClient,
    private readonly credentials: LineCredentialsService,
  ) {}

  /**
   * Reads every template of each WhatsApp Business account of the
   * business's active lines (with the token of one of its lines) and
   * upserts them; the ones Meta no longer returns get `deletedAt` (never
   * deleted). An account whose list fails keeps its rows unchanged.
   * 409 `NO_WHATSAPP_ACCOUNT` when no line has an account id and a token.
   */
  async sync(businessId: string): Promise<TemplatesSyncResult> {
    const accounts = await this.accounts(businessId);
    if (accounts.size === 0) {
      await this.prisma.business.update({
        where: { id: businessId },
        data: {
          templatesSyncedAt: new Date(),
          templatesSyncError: 'no_whatsapp_account',
        },
      });
      throw new ConflictException({
        message:
          'No active line has a WhatsApp Business account id and an access token',
        code: 'NO_WHATSAPP_ACCOUNT',
      });
    }
    const results: AccountSyncResult[] = [];
    for (const [wabaId, encryptedToken] of accounts) {
      results.push(await this.syncAccount(businessId, wabaId, encryptedToken));
    }
    const syncedAt = new Date();
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        templatesSyncedAt: syncedAt,
        templatesSyncError: results.find((r) => r.error)?.error ?? null,
        templatesSyncNextAt: new Date(
          syncedAt.getTime() + TEMPLATE_SYNC_INTERVAL_MS,
        ),
      },
    });
    return { syncedAt, accounts: results };
  }

  /**
   * The business's templates still in Meta, of the accounts of its active
   * lines (or only of the account of `lineId`), with their variables and whether the inbox can send
   * them. Sorted by name.
   */
  async list(businessId: string, lineId?: string) {
    // Only accounts that still have a line here (a line may change account).
    const lines = await this.prisma.line.findMany({
      where: {
        businessId,
        wabaId: { not: null },
        ...(lineId ? { id: lineId } : { active: true }),
      },
      select: { wabaId: true },
    });
    const wabaIds = [...new Set(lines.map((l) => l.wabaId!))];
    const [rows, business] = await Promise.all([
      this.prisma.template.findMany({
        where: { businessId, deletedAt: null, wabaId: { in: wabaIds } },
        select: templateSelect,
        orderBy: [{ name: 'asc' }, { language: 'asc' }],
      }),
      this.prisma.business.findUniqueOrThrow({
        where: { id: businessId },
        select: { templatesSyncedAt: true, templatesSyncError: true },
      }),
    ]);
    return {
      syncedAt: business.templatesSyncedAt,
      syncError: business.templatesSyncError,
      templates: rows.map((row) => templateView(row)),
    };
  }

  /** The template of this business by id (deleted ones included), or null. */
  find(businessId: string, templateId: string) {
    return this.prisma.template.findFirst({
      where: { id: templateId, businessId },
      select: { ...templateSelect, deletedAt: true },
    });
  }

  /** Account id → encrypted token of one of its active lines. */
  private async accounts(businessId: string): Promise<Map<string, string>> {
    const lines = await this.prisma.line.findMany({
      where: {
        businessId,
        active: true,
        wabaId: { not: null },
        accessTokenEncrypted: { not: null },
      },
      select: { wabaId: true, accessTokenEncrypted: true },
      orderBy: { createdAt: 'asc' },
    });
    const accounts = new Map<string, string>();
    for (const line of lines) {
      if (!accounts.has(line.wabaId!)) {
        accounts.set(line.wabaId!, line.accessTokenEncrypted!);
      }
    }
    return accounts;
  }

  private async syncAccount(
    businessId: string,
    wabaId: string,
    encryptedToken: string,
  ): Promise<AccountSyncResult> {
    let token: string;
    try {
      token = this.credentials.decrypt(encryptedToken);
    } catch (error) {
      if (!(error instanceof CredentialsDecryptError)) {
        throw error;
      }
      return { wabaId, synced: 0, deleted: 0, error: 'token_unreadable' };
    }
    const result = await this.graph.messageTemplates(wabaId, token);
    if (!result.ok) {
      const code = result.error.code;
      const error = typeof code === 'number' ? `meta_${code}` : code;
      this.logger.warn(
        `Template sync failed for business ${businessId}, account ${wabaId}: ${error}`,
      );
      return { wabaId, synced: 0, deleted: 0, error };
    }
    const deleted = await this.store(businessId, wabaId, result.data);
    return { wabaId, synced: result.data.length, deleted, error: null };
  }

  /** Upserts the full list and marks the rest deleted; returns how many. */
  private async store(
    businessId: string,
    wabaId: string,
    templates: MetaTemplate[],
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const keep: Prisma.TemplateWhereInput[] = [];
      for (const t of templates) {
        const data = {
          metaId: t.id,
          category: t.category,
          status: t.status,
          components: t.components as Prisma.InputJsonValue,
          deletedAt: null,
        };
        await tx.template.upsert({
          where: {
            businessId_wabaId_name_language: {
              businessId,
              wabaId,
              name: t.name,
              language: t.language,
            },
          },
          create: {
            businessId,
            wabaId,
            name: t.name,
            language: t.language,
            ...data,
          },
          update: data,
        });
        keep.push({ name: t.name, language: t.language });
      }
      const { count } = await tx.template.updateMany({
        where: {
          businessId,
          wabaId,
          deletedAt: null,
          ...(keep.length > 0 ? { NOT: { OR: keep } } : {}),
        },
        data: { deletedAt: new Date() },
      });
      return count;
    });
  }
}

/** What the inbox needs to pick a template and preview it. */
function templateView(row: {
  id: string;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: Prisma.JsonValue;
}) {
  const unsupported = unsupportedReason(row.category, row.components);
  const parts = componentTexts(row.components);
  return {
    id: row.id,
    wabaId: row.wabaId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    sendable: row.status === 'APPROVED' && unsupported === null,
    unsupportedReason: unsupported,
    variables: templateVariables(row.components),
    ...parts,
  };
}

function componentTexts(components: Prisma.JsonValue) {
  let header: string | null = null;
  let body = '';
  let footer: string | null = null;
  const buttons: string[] = [];
  for (const raw of Array.isArray(components) ? components : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const type =
      typeof raw['type'] === 'string' ? raw['type'].toUpperCase() : '';
    const text = typeof raw['text'] === 'string' ? raw['text'] : null;
    if (type === 'HEADER') {
      header = text;
    } else if (type === 'BODY') {
      body = text ?? '';
    } else if (type === 'FOOTER') {
      footer = text;
    } else if (type === 'BUTTONS' && Array.isArray(raw['buttons'])) {
      for (const button of raw['buttons']) {
        if (
          button &&
          typeof button === 'object' &&
          !Array.isArray(button) &&
          typeof button['text'] === 'string'
        ) {
          buttons.push(button['text']);
        }
      }
    }
  }
  return { header, body, footer, buttons };
}
