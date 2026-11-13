import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { catalogNameKey, lockBusiness } from '../catalog/catalogs.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import {
  type ContactTag,
  type ContactTagAssigner,
  Prisma,
} from '../generated/prisma/client.js';
import { enqueueEvent } from '../integrations/events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ContactTagChanges,
  type NewContactTag,
  tagKeyOf,
  uniqueTagKey,
} from './contact-tags.js';

type Tx = Prisma.TransactionClient;

/** A tag as the settings screen sees it. */
export interface ContactTagView {
  id: string;
  name: string;
  key: string;
  assignedBy: ContactTagAssigner;
  botHint: string | null;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A tag as a conversation shows it on its contact. */
export interface ContactTagChip {
  id: string;
  name: string;
  color: string;
  /** Who put it on this contact: the bot (tag_contact) or a person. */
  source: ContactTagAssigner;
}

/** GET /inbox/.../contact-tags: a tag to choose in the inbox. */
export interface ContactTagOption {
  id: string;
  name: string;
  color: string;
  assignedBy: ContactTagAssigner;
}

/** A tag the bot may put (tag_contact): business information. */
export interface BotTag {
  key: string;
  name: string;
  botHint: string | null;
}

/** A contact's current tags, as the inbox shows them (by name). */
export const CURRENT_TAGS = {
  where: { removedAt: null },
  orderBy: { tag: { name: 'asc' } },
  select: {
    source: true,
    tag: { select: { id: true, name: true, color: true } },
  },
} satisfies Prisma.Contact$tagsArgs;

/** A current tag row (CURRENT_TAGS) as the inbox shows it. */
export function tagChip(row: {
  source: ContactTagAssigner;
  tag: { id: string; name: string; color: string };
}): ContactTagChip {
  return { ...row.tag, source: row.source };
}

const tagNotFound = () => new NotFoundException('Contact tag not found');

const nameTaken = () =>
  new ConflictException({
    message: 'Ya hay una etiqueta con ese nombre.',
    code: 'CONTACT_TAG_NAME_TAKEN',
  });

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function view(tag: ContactTag): ContactTagView {
  return {
    id: tag.id,
    name: tag.name,
    key: tag.key,
    assignedBy: tag.assignedBy,
    botHint: tag.botHint,
    color: tag.color,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  };
}

/** Why tag_contact left a key out (debug log only). */
type IgnoredReason =
  | 'unknown'
  | 'person_only'
  | 'removed_by_person'
  | 'put_by_person'
  | 'add_and_remove';

/**
 * Raises version of the contact's conversations (the inbox /changes cursor).
 * A conversation another bot turn holds is skipped instead of waited for:
 * that turn holds it while it waits for this contact, so waiting would
 * deadlock. The skipped one shows the new tags on its next change.
 */
const touchConversationsOfContact = (tx: Tx, contactId: string) =>
  tx.$executeRaw`
    UPDATE conversation SET updated_at = updated_at
    WHERE id IN (
      SELECT id FROM conversation
      WHERE contact_id = ${contactId}::uuid
      FOR UPDATE SKIP LOCKED
    )`;
const touchConversationsWithTag = (tx: Tx, tagId: string) =>
  tx.$executeRaw`
    UPDATE conversation SET updated_at = updated_at
    WHERE contact_id IN (
      SELECT contact_id FROM contact_tag_assignment
      WHERE tag_id = ${tagId}::uuid AND removed_at IS NULL)`;

/**
 * The tags each business defines for its contacts, and the tags each
 * contact has. A person puts or takes off any tag; the bot (tag_contact)
 * only puts BOT tags, never one a person took off, and only takes off what
 * it put. Every change of a contact's tags raises the version of its
 * conversations (so the inbox polling sees it) and emits
 * `contact.tags_changed`.
 */
@Injectable()
export class ContactTagsService {
  private readonly logger = new Logger(ContactTagsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The tags a person can put on a contact (any role): what the inbox needs
   * to tag and to filter, without the bot's hints.
   */
  async options(businessId: string): Promise<ContactTagOption[]> {
    return this.prisma.contactTag.findMany({
      where: { businessId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true, assignedBy: true },
    });
  }

  async list(businessId: string): Promise<ContactTagView[]> {
    const tags = await this.prisma.contactTag.findMany({
      where: { businessId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return tags.map(view);
  }

  /**
   * 409 CONTACT_TAG_LIMIT_REACHED over CONTACT_TAGS_MAX_PER_BUSINESS, 409
   * CONTACT_TAG_NAME_TAKEN.
   */
  async create(
    businessId: string,
    input: NewContactTag,
  ): Promise<ContactTagView> {
    const created = await this.prisma.$transaction(async (tx) => {
      await lockBusiness(tx, businessId);
      const tags = await tx.contactTag.findMany({
        where: { businessId },
        select: { nameKey: true, key: true },
      });
      const max = this.config.get('CONTACT_TAGS_MAX_PER_BUSINESS');
      if (tags.length >= max) {
        throw new ConflictException({
          message: `El negocio ya tiene ${max} etiquetas, el máximo.`,
          code: 'CONTACT_TAG_LIMIT_REACHED',
        });
      }
      const nameKey = catalogNameKey(input.name);
      if (tags.some((t) => t.nameKey === nameKey)) {
        throw nameTaken();
      }
      return tx.contactTag.create({
        data: {
          businessId,
          name: input.name,
          nameKey,
          key: uniqueTagKey(
            tagKeyOf(input.name),
            new Set(tags.map((t) => t.key)),
          ),
          assignedBy: input.assignedBy,
          botHint: input.assignedBy === 'BOT' ? (input.botHint ?? null) : null,
          color: input.color,
        },
      });
    });
    this.logger.log(
      JSON.stringify({
        event: 'contact_tag_created',
        businessId,
        tagId: created.id,
      }),
    );
    return view(created);
  }

  /** Renames, recolors or changes who puts it; the key never changes. */
  async update(
    businessId: string,
    tagId: string,
    changes: ContactTagChanges,
  ): Promise<ContactTagView> {
    return this.prisma.$transaction(async (tx) => {
      await lockBusiness(tx, businessId);
      const tag = await this.tagOf(tx, businessId, tagId);
      const assignedBy = changes.assignedBy ?? tag.assignedBy;
      if (assignedBy === 'PERSON' && changes.botHint) {
        throw new BadRequestException(
          'botHint is only for tags the bot puts (assignedBy BOT)',
        );
      }
      const name = changes.name;
      let updated: ContactTag;
      try {
        updated = await tx.contactTag.update({
          where: { id: tag.id },
          data: {
            ...(name === undefined
              ? {}
              : { name, nameKey: catalogNameKey(name) }),
            ...(changes.color === undefined ? {} : { color: changes.color }),
            assignedBy,
            botHint:
              assignedBy === 'PERSON'
                ? null
                : changes.botHint === undefined
                  ? tag.botHint
                  : changes.botHint,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw nameTaken();
        }
        throw error;
      }
      if (updated.name !== tag.name || updated.color !== tag.color) {
        await touchConversationsWithTag(tx, tag.id);
      }
      return view(updated);
    });
  }

  /**
   * Deletes the tag and takes it off every contact. 409 TAG_IN_USE (with
   * the catalogs) while a catalog is seen through it.
   */
  async remove(businessId: string, tagId: string): Promise<{ deleted: true }> {
    await this.prisma.$transaction(async (tx) => {
      await lockBusiness(tx, businessId);
      const tag = await this.tagOf(tx, businessId, tagId);
      const uses = await tx.catalogTag.findMany({
        where: { tagId: tag.id },
        select: { catalog: { select: { id: true, name: true } } },
        orderBy: { catalog: { position: 'asc' } },
      });
      if (uses.length > 0) {
        throw new ConflictException({
          message:
            'La etiqueta la usa un catálogo. Sacala del catálogo antes de borrarla.',
          code: 'TAG_IN_USE',
          catalogs: uses.map((u) => u.catalog),
        });
      }
      await touchConversationsWithTag(tx, tag.id);
      await tx.contactTag.delete({ where: { id: tag.id } });
    });
    this.logger.log(
      JSON.stringify({ event: 'contact_tag_deleted', businessId, tagId }),
    );
    return { deleted: true };
  }

  /**
   * A person replaces the contact's tags: new ones are PERSON (also one the
   * bot or a person had taken off), the ones left out stay with removed_at
   * and removed_by_id. 404 for a contact or a tag of another business.
   */
  async setForContact(
    businessId: string,
    contactId: string,
    tagIds: readonly string[],
    user: { id: string; name: string },
  ): Promise<{ tags: ContactTagChip[] }> {
    await this.prisma.$transaction(async (tx) => {
      // Same lock order as a bot turn (its conversation, then the contact),
      // so a person and the bot changing one contact never deadlock.
      await tx.$queryRaw`
        SELECT c.id FROM conversation c
          JOIN contact k ON k.id = c.contact_id
        WHERE k.id = ${contactId}::uuid AND k.business_id = ${businessId}::uuid
        ORDER BY c.id
        FOR UPDATE OF c`;
      await this.lockContact(tx, businessId, contactId);
      const found = await tx.contactTag.count({
        where: { businessId, id: { in: [...tagIds] } },
      });
      if (found !== tagIds.length) {
        throw tagNotFound();
      }
      await this.changeTags(
        tx,
        contactId,
        { source: 'PERSON', changedBy: { id: user.id, name: user.name } },
        async (current) => {
          const keep = new Set(tagIds);
          const now = new Date();
          for (const tagId of keep) {
            if (current.has(tagId)) {
              continue;
            }
            await tx.contactTagAssignment.upsert({
              where: { contactId_tagId: { contactId, tagId } },
              create: {
                contactId,
                tagId,
                source: 'PERSON',
                createdById: user.id,
              },
              update: {
                source: 'PERSON',
                createdById: user.id,
                createdAt: now,
                removedAt: null,
                removedById: null,
              },
            });
          }
          const off = [...current].filter((tagId) => !keep.has(tagId));
          if (off.length > 0) {
            await tx.contactTagAssignment.updateMany({
              where: { contactId, tagId: { in: off } },
              data: { removedAt: now, removedById: user.id },
            });
          }
        },
      );
    });
    return { tags: await this.chipsOf(contactId) };
  }

  /** The business's BOT tags (tag_contact is offered only with one). */
  async botTags(businessId: string): Promise<BotTag[]> {
    return this.prisma.contactTag.findMany({
      where: { businessId, assignedBy: 'BOT' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { key: true, name: true, botHint: true },
    });
  }

  /**
   * tag_contact's effect, inside the job's transaction. Keys that are not a
   * BOT tag of the conversation's business, that a person took off, or (to
   * take off) that a person put, are ignored with a debug log: never an
   * error to the customer. The bot takes off a tag by deleting its row, so
   * removed_at always means a person took it off.
   */
  async applyFromBot(
    tx: Tx,
    conversationId: string,
    keys: { add: readonly string[]; remove: readonly string[] },
  ): Promise<void> {
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contactId: true, line: { select: { businessId: true } } },
    });
    const { contactId } = conversation;
    const businessId = conversation.line.businessId;
    await this.lockContact(tx, businessId, contactId);
    const ignore = (key: string, reason: IgnoredReason) =>
      this.logger.debug(
        JSON.stringify({
          event: 'tag_contact_ignored',
          conversationId,
          key,
          reason,
        }),
      );
    const both = new Set(keys.add.filter((k) => keys.remove.includes(k)));
    both.forEach((key) => ignore(key, 'add_and_remove'));
    const add = new Set(keys.add.filter((k) => !both.has(k)));
    const remove = new Set(keys.remove.filter((k) => !both.has(k)));

    const tags = await tx.contactTag.findMany({
      where: { businessId, key: { in: [...add, ...remove] } },
      select: {
        id: true,
        key: true,
        assignedBy: true,
        assignments: { where: { contactId } },
      },
    });
    const byKey = new Map(tags.map((t) => [t.key, t]));

    await this.changeTags(
      tx,
      contactId,
      { source: 'BOT', changedBy: null, conversationId },
      async () => {
        for (const key of add) {
          const tag = byKey.get(key);
          if (!tag) {
            ignore(key, 'unknown');
            continue;
          }
          if (tag.assignedBy !== 'BOT') {
            ignore(key, 'person_only');
            continue;
          }
          const [assignment] = tag.assignments;
          if (assignment?.removedAt) {
            ignore(key, 'removed_by_person');
            continue;
          }
          if (!assignment) {
            await tx.contactTagAssignment.create({
              data: { contactId, tagId: tag.id, source: 'BOT' },
            });
          }
        }
        for (const key of remove) {
          const tag = byKey.get(key);
          if (!tag) {
            ignore(key, 'unknown');
            continue;
          }
          const [assignment] = tag.assignments;
          if (!assignment || assignment.removedAt) {
            continue;
          }
          if (assignment.source !== 'BOT') {
            ignore(key, 'put_by_person');
            continue;
          }
          await tx.contactTagAssignment.delete({
            where: { id: assignment.id },
          });
        }
      },
    );
  }

  /**
   * Runs `mutate` with the contact's current tag ids; when they changed,
   * raises its conversations' version and emits `contact.tags_changed` on
   * `conversationId` (by default the contact's latest conversation; a
   * contact without one emits nothing).
   */
  private async changeTags(
    tx: Tx,
    contactId: string,
    origin: {
      source: ContactTagAssigner;
      changedBy: { id: string; name: string } | null;
      conversationId?: string;
    },
    mutate: (current: ReadonlySet<string>) => Promise<void>,
  ): Promise<void> {
    const before = await this.eventTagsOf(tx, contactId);
    await mutate(new Set(before.map((t) => t.id)));
    const after = await this.eventTagsOf(tx, contactId);
    const same =
      before.length === after.length &&
      before.every((t, i) => t.id === after[i]!.id);
    if (same) {
      return;
    }
    await touchConversationsOfContact(tx, contactId);
    const conversationId =
      origin.conversationId ??
      (
        await tx.conversation.findFirst({
          where: { contactId },
          orderBy: [
            { lastMessageAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
          ],
          select: { id: true },
        })
      )?.id;
    if (!conversationId) {
      return;
    }
    await enqueueEvent(tx, {
      conversationId,
      type: 'contact.tags_changed',
      data: {
        source: origin.source,
        changedBy: origin.changedBy,
        tags: { before, after },
      },
    });
  }

  /** The contact's current tags for the event, by name. */
  private async eventTagsOf(tx: Tx, contactId: string) {
    const rows = await tx.contactTagAssignment.findMany({
      where: { contactId, removedAt: null },
      orderBy: [{ tag: { name: 'asc' } }, { tagId: 'asc' }],
      select: { tag: { select: { id: true, key: true, name: true } } },
    });
    return rows.map((r) => r.tag);
  }

  private async chipsOf(contactId: string): Promise<ContactTagChip[]> {
    const rows = await this.prisma.contactTagAssignment.findMany({
      where: { contactId, ...CURRENT_TAGS.where },
      orderBy: CURRENT_TAGS.orderBy,
      select: CURRENT_TAGS.select,
    });
    return rows.map(tagChip);
  }

  /** Serializes the tag changes of one contact. 404 for another business's. */
  private async lockContact(
    tx: Tx,
    businessId: string,
    contactId: string,
  ): Promise<void> {
    const [found] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM contact
      WHERE id = ${contactId}::uuid AND business_id = ${businessId}::uuid
      FOR UPDATE`;
    if (!found) {
      throw new NotFoundException('Contact not found');
    }
  }

  private async tagOf(
    tx: Tx,
    businessId: string,
    tagId: string,
  ): Promise<ContactTag> {
    const tag = await tx.contactTag.findFirst({
      where: { id: tagId, businessId },
    });
    if (!tag) {
      throw tagNotFound();
    }
    return tag;
  }
}
