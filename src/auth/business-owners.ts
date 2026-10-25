import type { MembershipRole } from '../generated/prisma/client.js';

export interface MemberState {
  userId: string;
  role: MembershipRole;
  active: boolean;
}

/** A change to one member's role or active flag (fields left out stay). */
export interface MemberChange {
  userId: string;
  role?: MembershipRole;
  active?: boolean;
}

/** Whether the business still has an active OWNER after the change. */
export function keepsAnActiveOwner(
  members: readonly MemberState[],
  change: MemberChange,
): boolean {
  return members
    .map((m) =>
      m.userId === change.userId
        ? {
            ...m,
            role: change.role ?? m.role,
            active: change.active ?? m.active,
          }
        : m,
    )
    .some((m) => m.role === 'OWNER' && m.active);
}
