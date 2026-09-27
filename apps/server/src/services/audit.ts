import { auditHash, type ChainAuditRow } from "@cosimo/core";
import { newId, type OrgTx, org } from "@cosimo/db";
import { desc, eq } from "drizzle-orm";
import type { ActorInfo } from "./actor.ts";

export interface AuditInput {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

function toJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v, (k, val) =>
    /(secret|token|password|_enc$)/i.test(k) && val != null ? "[omitted]" : val,
  );
}

export async function metaValue(tx: OrgTx, key: string): Promise<string | null> {
  const row = await tx.select().from(org.schemaMeta).where(eq(org.schemaMeta.key, key)).get();
  return row?.value ?? null;
}

/**
 * Append a row to the org audit log, extending the audit hash chain. MUST be called inside the
 * org write transaction (DbHandle.write) so chain extension is serialized.
 */
export async function appendAudit(tx: OrgTx, orgId: string, a: ActorInfo, input: AuditInput) {
  const last = await tx
    .select({ seq: org.auditLog.seq, hash: org.auditLog.hash })
    .from(org.auditLog)
    .orderBy(desc(org.auditLog.seq))
    .limit(1)
    .get();
  const prevHash = last?.hash ?? (await metaValue(tx, "audit_genesis"));
  if (!prevHash) throw new Error("audit genesis missing");
  const row: ChainAuditRow = {
    id: newId(),
    seq: (last?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    userId: a.userId ?? null,
    apiTokenId: a.apiTokenId ?? null,
    oauthClientId: a.oauthClientId ?? null,
    actor: a.actor,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    beforeJson: toJson(input.before),
    afterJson: toJson(input.after),
    ip: a.ip ?? null,
  };
  const hash = auditHash(orgId, prevHash, row);
  await tx.insert(org.auditLog).values({ ...row, prevHash, hash });
  return { ...row, prevHash, hash };
}
