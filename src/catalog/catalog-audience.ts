/** A catalog as the audience rule sees it (prompt 12b). */
export interface AudienceCatalog {
  id: string;
  audience: 'ALL' | 'TAGGED';
  replacesAll: boolean;
  /** With TAGGED: a contact with any of these tags sees it. */
  tagIds: readonly string[];
}

/**
 * The catalogs a contact sees, in the given order: every ALL catalog, and
 * each TAGGED one whose tags include one of the contact's. When a seen
 * TAGGED catalog replaces the ALL ones (a wholesaler must not see retail
 * prices), the ALL ones are left out. Pure: the caller reads the contact's
 * current tags right before (no cache).
 */
export function visibleCatalogIds(
  catalogs: readonly AudienceCatalog[],
  contactTagIds: ReadonlySet<string>,
): string[] {
  const seenTagged = new Set(
    catalogs
      .filter(
        (c) =>
          c.audience === 'TAGGED' && c.tagIds.some((t) => contactTagIds.has(t)),
      )
      .map((c) => c.id),
  );
  const replaces = catalogs.some((c) => c.replacesAll && seenTagged.has(c.id));
  return catalogs
    .filter((c) => (c.audience === 'ALL' ? !replaces : seenTagged.has(c.id)))
    .map((c) => c.id);
}
