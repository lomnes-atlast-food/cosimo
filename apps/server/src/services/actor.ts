import type { Actor, Role } from "@cosimo/shared";

/** Who is doing something inside one org. */
export interface ActorInfo {
  actor: Actor;
  role: Role;
  userId: string | null;
  apiTokenId?: string | null;
  oauthClientId?: string | null;
  ip?: string | null;
  /** API tokens configured to propose only: every write goes to the review queue. */
  proposeOnly?: boolean;
  /** Optional human-readable name for display in the review queue. */
  displayName?: string;
}

export const SYSTEM_ACTOR: ActorInfo = { actor: "system", role: "owner", userId: null };

export function systemActor(userId: string | null = null): ActorInfo {
  return { actor: "system", role: "owner", userId };
}

export function userActor(userId: string, role: Role, ip?: string | null): ActorInfo {
  return { actor: "user", role, userId, ip: ip ?? null };
}
