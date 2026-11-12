import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import {
  type Catalog,
  type CatalogAudience,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The catalog an operation acts on, already checked to be the business's. */
export interface CatalogRef {
  businessId: string;
  catalogId: string;
}

/** What a business's current catalog is called (migration and old routes). */
export const DEFAULT_CATALOG_NAME = 'Catálogo principal';

export interface CatalogSheetState {
  url: string | null;
  syncedAt: Date | null;
  /** Code of the last sync's failure (e.g. sheet_http_404), or null. */
  syncError: string | null;
  nextSyncAt: Date | null;
}

export interface CatalogView {
  id: string;
  name: string;
  /** Order in the screens; the first catalog is the old routes'. */
  position: number;
  availableItems: number;
  sheet: CatalogSheetState;
  /** ALL: every contact; TAGGED: contacts with one of `tagIds`. */
  audience: CatalogAudience;
  tagIds: string[];
  /** TAGGED only: a contact who sees it no longer sees the ALL ones. */
  replacesAll: boolean;
  createdAt: Date;
}

/** PATCH .../catalogs/:catalogId */
export interface CatalogChanges {
  name?: string;
  position?: number;
  audience?: CatalogAudience;
  tagIds?: string[];
  replacesAll?: boolean;
}

type CatalogWithTags = Catalog & { tags: Array<{ tagId: string }> };

const WITH_TAGS = {
  tags: { select: { tagId: true }, orderBy: { tagId: 'asc' } },
} satisfies Prisma.CatalogInclude;

const badAudience = (message: string, code: string) =>
  new BadRequestException({ message, code });

/**
 * The name as it is compared: lower case, without accents nor repeated
 * spaces ("Catálogo  Mayorista" and "catalogo mayorista" are the same).
 */
export function catalogNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The name as it is stored: trimmed, without repeated spaces. */
function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

const ORDER: Prisma.CatalogOrderByWithRelationInput[] = [
  { position: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

const notFound = () => new NotFoundException('Catalog not found');

const nameTaken = () =>
  new ConflictException({
    message: 'Ya hay un catálogo con ese nombre.',
    code: 'CATALOG_NAME_TAKEN',
  });

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export function sheetState(catalog: Catalog): CatalogSheetState {
  return {
    url: catalog.sheetUrl,
    syncedAt: catalog.syncedAt,
    syncError: catalog.syncError,
    nextSyncAt: catalog.sheetUrl ? catalog.syncNextAt : null,
  };
}

/**
 * A business's catalogs: create, rename, reorder and delete them, and tell
 * which one an operation acts on. The old routes (without a catalog) act on
 * the first one by position, created as "Catálogo principal" when the
 * business has none yet.
 */
@Injectable()
export class CatalogsService {
  private readonly logger = new Logger(CatalogsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The catalog to act on: the given one (404 when it is not the
   * business's), or the first one for the old routes.
   */
  async resolve(
    businessId: string,
    catalogId: string | undefined,
  ): Promise<CatalogRef> {
    if (catalogId === undefined) {
      return { businessId, catalogId: (await this.first(businessId)).id };
    }
    const found = await this.prisma.catalog.findFirst({
      where: { id: catalogId, businessId },
      select: { id: true },
    });
    if (!found) {
      throw notFound();
    }
    return { businessId, catalogId: found.id };
  }

  /** The business's catalogs in order (creating the first one if needed). */
  async list(businessId: string): Promise<CatalogView[]> {
    await this.first(businessId);
    const catalogs = await this.prisma.catalog.findMany({
      where: { businessId },
      orderBy: ORDER,
      include: WITH_TAGS,
    });
    const counts = await this.prisma.catalogItem.groupBy({
      by: ['catalogId'],
      where: { businessId, available: true },
      _count: { _all: true },
    });
    const available = new Map(counts.map((c) => [c.catalogId, c._count._all]));
    return catalogs.map((c) => this.view(c, available.get(c.id) ?? 0));
  }

  /**
   * Adds a catalog at the end. 409 CATALOG_LIMIT_REACHED over
   * CATALOG_MAX_CATALOGS_PER_BUSINESS, 409 CATALOG_NAME_TAKEN.
   */
  async create(businessId: string, rawName: string): Promise<CatalogView> {
    const name = cleanName(rawName);
    const created = await this.prisma.$transaction(async (tx) => {
      await lockBusiness(tx, businessId);
      const catalogs = await tx.catalog.findMany({
        where: { businessId },
        select: { position: true, nameKey: true },
      });
      const max = this.config.get('CATALOG_MAX_CATALOGS_PER_BUSINESS');
      if (catalogs.length >= max) {
        throw new ConflictException({
          message: `El negocio ya tiene ${max} catálogos, el máximo.`,
          code: 'CATALOG_LIMIT_REACHED',
        });
      }
      const nameKey = catalogNameKey(name);
      if (catalogs.some((c) => c.nameKey === nameKey)) {
        throw nameTaken();
      }
      const position =
        catalogs.length === 0
          ? 0
          : Math.max(...catalogs.map((c) => c.position)) + 1;
      return tx.catalog.create({
        data: { businessId, name, nameKey, position },
        include: WITH_TAGS,
      });
    });
    this.logger.log(
      JSON.stringify({
        event: 'catalog_created',
        businessId,
        catalogId: created.id,
      }),
    );
    return this.view(created, 0);
  }

  /**
   * Renames or moves a catalog, or changes who sees it. 409
   * CATALOG_NAME_TAKEN; 400 TAGGED_WITHOUT_TAGS, TAGS_ONLY_FOR_TAGGED or
   * REPLACES_ALL_ONLY_FOR_TAGGED; 404 for a tag of another business.
   * Back to ALL, the catalog drops its tags and replacesAll.
   */
  async update(ref: CatalogRef, changes: CatalogChanges): Promise<CatalogView> {
    const name =
      changes.name === undefined ? undefined : cleanName(changes.name);
    let updated: CatalogWithTags;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        // Same lock as deleting a tag: a tag in use is never deleted.
        await lockBusiness(tx, ref.businessId);
        const current = await tx.catalog.findUniqueOrThrow({
          where: { id: ref.catalogId },
          include: WITH_TAGS,
        });
        const audience = await this.audienceOf(tx, ref, current, changes);
        const tagsChanged =
          audience.tagIds.join() !== current.tags.map((t) => t.tagId).join();
        if (tagsChanged) {
          await tx.catalogTag.deleteMany({
            where: { catalogId: ref.catalogId },
          });
          await tx.catalogTag.createMany({
            data: audience.tagIds.map((tagId) => ({
              catalogId: ref.catalogId,
              tagId,
            })),
          });
        }
        return tx.catalog.update({
          where: { id: ref.catalogId },
          data: {
            ...(name === undefined
              ? {}
              : { name, nameKey: catalogNameKey(name) }),
            ...(changes.position === undefined
              ? {}
              : { position: changes.position }),
            audience: audience.audience,
            replacesAll: audience.replacesAll,
          },
          include: WITH_TAGS,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw nameTaken();
      }
      throw error;
    }
    const availableItems = await this.prisma.catalogItem.count({
      where: { catalogId: ref.catalogId, available: true },
    });
    return this.view(updated, availableItems);
  }

  /** The catalog's audience after `changes` (see update). */
  private async audienceOf(
    tx: Prisma.TransactionClient,
    ref: CatalogRef,
    current: CatalogWithTags,
    changes: CatalogChanges,
  ): Promise<{
    audience: CatalogAudience;
    tagIds: string[];
    replacesAll: boolean;
  }> {
    const audience = changes.audience ?? current.audience;
    if (audience === 'ALL') {
      if (changes.tagIds !== undefined && changes.tagIds.length > 0) {
        throw badAudience(
          'Solo un catálogo para contactos con etiquetas lleva etiquetas.',
          'TAGS_ONLY_FOR_TAGGED',
        );
      }
      if (changes.replacesAll) {
        throw badAudience(
          'Solo un catálogo para contactos con etiquetas puede reemplazar a los catálogos para todos.',
          'REPLACES_ALL_ONLY_FOR_TAGGED',
        );
      }
      return { audience, tagIds: [], replacesAll: false };
    }
    const tagIds = [
      ...(changes.tagIds ?? current.tags.map((t) => t.tagId)),
    ].sort();
    if (tagIds.length === 0) {
      throw badAudience(
        'Elegí al menos una etiqueta para el catálogo.',
        'TAGGED_WITHOUT_TAGS',
      );
    }
    if (changes.tagIds !== undefined) {
      const found = await tx.contactTag.count({
        where: { businessId: ref.businessId, id: { in: tagIds } },
      });
      if (found !== tagIds.length) {
        throw new NotFoundException('Contact tag not found');
      }
    }
    return {
      audience,
      tagIds,
      replacesAll: changes.replacesAll ?? current.replacesAll,
    };
  }

  /**
   * Deletes a catalog with its items and imports. 409 LAST_CATALOG for the
   * business's only one (the old routes and the bot need one).
   */
  async remove(ref: CatalogRef): Promise<{ deleted: true; items: number }> {
    const items = await this.prisma.$transaction(async (tx) => {
      await lockBusiness(tx, ref.businessId);
      const count = await tx.catalog.count({
        where: { businessId: ref.businessId },
      });
      if (count <= 1) {
        throw new ConflictException({
          message: 'No podés borrar el único catálogo del negocio.',
          code: 'LAST_CATALOG',
        });
      }
      const removed = await tx.catalogItem.count({
        where: { catalogId: ref.catalogId },
      });
      await tx.catalog.delete({ where: { id: ref.catalogId } });
      return removed;
    });
    this.logger.log(
      JSON.stringify({
        event: 'catalog_deleted',
        businessId: ref.businessId,
        catalogId: ref.catalogId,
        items,
      }),
    );
    return { deleted: true, items };
  }

  /**
   * The business's first catalog by position; a business without any gets
   * "Catálogo principal" (404 when the business does not exist).
   */
  private async first(businessId: string): Promise<Catalog> {
    const found = await this.prisma.catalog.findFirst({
      where: { businessId },
      orderBy: ORDER,
    });
    if (found) {
      return found;
    }
    return this.prisma.$transaction(async (tx) => {
      await lockBusiness(tx, businessId);
      // Another request may have created it while this one waited.
      const again = await tx.catalog.findFirst({
        where: { businessId },
        orderBy: ORDER,
      });
      return (
        again ??
        tx.catalog.create({
          data: {
            businessId,
            name: DEFAULT_CATALOG_NAME,
            nameKey: catalogNameKey(DEFAULT_CATALOG_NAME),
            position: 0,
          },
        })
      );
    });
  }

  private view(catalog: CatalogWithTags, availableItems: number): CatalogView {
    return {
      id: catalog.id,
      name: catalog.name,
      position: catalog.position,
      availableItems,
      sheet: sheetState(catalog),
      audience: catalog.audience,
      tagIds: catalog.tags.map((t) => t.tagId),
      replacesAll: catalog.replacesAll,
      createdAt: catalog.createdAt,
    };
  }
}

/**
 * Serializes the catalog writes of one business (catalogs and items), so
 * the caps hold. 404 when the business does not exist.
 */
export async function lockBusiness(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<{ catalogItemCap: number | null }> {
  const [business] = await tx.$queryRaw<
    Array<{ catalog_item_cap: number | null }>
  >`SELECT catalog_item_cap FROM business WHERE id = ${businessId}::uuid FOR UPDATE`;
  if (!business) {
    throw new NotFoundException('Business not found');
  }
  return { catalogItemCap: business.catalog_item_cap };
}
