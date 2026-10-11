/**
 * TEMPORARY (Stage 2): bounded in-memory set of recently seen message ids,
 * used to drop duplicate webhook deliveries. Lost on restart and not shared
 * between instances. Stage 3 replaces it with the unique constraint on
 * `Message.waMessageId` in PostgreSQL.
 */
export class RecentIds {
  private readonly ids = new Map<string, true>();

  constructor(private readonly capacity = 5_000) {}

  /** Records the id; returns false when it was already seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) {
      return false;
    }
    this.ids.set(id, true);
    if (this.ids.size > this.capacity) {
      // Maps iterate in insertion order: the first key is the oldest.
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
      }
    }
    return true;
  }
}
