import { newId, system } from "@cosimo/db";
import type { SystemHandle } from "./types.ts";

/** Instance-level audit events (not tied to one org's books). */
export async function instanceAudit(
  sys: SystemHandle,
  e: {
    userId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: unknown;
    ip?: string | null;
  },
) {
  await sys.write((tx) =>
    tx.insert(system.instanceAudit).values({
      id: newId(),
      userId: e.userId ?? null,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      detailJson: e.detail === undefined ? null : JSON.stringify(e.detail),
      ip: e.ip ?? null,
    }),
  );
}
