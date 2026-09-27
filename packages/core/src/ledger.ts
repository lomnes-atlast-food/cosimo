/**
 * Pure ledger rules (SPEC §6). The database enforces the same invariants with triggers; these
 * functions give clear errors before a write is attempted.
 */
import type { AccountType, Actor, Role } from "@cosimo/shared";

export interface LineInput {
  accountId: string;
  amount: number;
  description?: string | null;
  contactId?: string | null;
}

export interface AccountRef {
  id: string;
  type: AccountType;
  isActive: boolean;
  currency: string;
}

export interface LedgerError {
  code: string;
  message: string;
  line?: number;
}

export function sumLines(lines: { amount: number }[]): number {
  let s = 0;
  for (const l of lines) s += l.amount;
  return s;
}

/** Validate lines of an entry that is about to be posted (or saved as a draft when `forPosting` is false). */
export function validateLines(
  lines: LineInput[],
  accounts: Map<string, AccountRef>,
  baseCurrency: string,
  opts: { forPosting: boolean } = { forPosting: true },
): LedgerError[] {
  const errors: LedgerError[] = [];
  lines.forEach((l, i) => {
    if (!Number.isSafeInteger(l.amount))
      errors.push({ code: "invalid_amount", message: "Amounts must be integer cents.", line: i });
    if (l.amount === 0) errors.push({ code: "zero_amount", message: "Line amount cannot be zero.", line: i });
    const a = accounts.get(l.accountId);
    if (!a) errors.push({ code: "unknown_account", message: `Unknown account ${l.accountId}.`, line: i });
    else {
      if (!a.isActive && opts.forPosting)
        errors.push({ code: "inactive_account", message: "Account is inactive.", line: i });
      if (a.currency !== baseCurrency) {
        errors.push({
          code: "currency_mismatch",
          message: `Only ${baseCurrency} is supported in v1.`,
          line: i,
        });
      }
    }
  });
  if (opts.forPosting) {
    if (lines.length < 2)
      errors.push({ code: "too_few_lines", message: "An entry needs at least two lines." });
    const s = sumLines(lines);
    if (s !== 0) {
      errors.push({
        code: "unbalanced",
        message: `Debits and credits differ by ${s > 0 ? "" : "-"}${(Math.abs(s) / 100).toFixed(2)}.`,
      });
    }
  }
  return errors;
}

/** Lines of the reversing entry: every amount negated. */
export function reversalLines<T extends LineInput>(lines: T[]): LineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    amount: -l.amount,
    description: l.description ?? null,
    contactId: l.contactId ?? null,
  }));
}

export interface LockSettings {
  softLockDate: string | null;
  hardLockDate: string | null;
}

export type LockCheck =
  | { ok: true; overridesSoftLock: boolean }
  | { ok: false; code: "hard_locked" | "soft_locked"; message: string };

/**
 * Lock date rules (SPEC §6 #3): the hard lock blocks everyone; the soft lock blocks everyone except
 * owners acting in person who provide a note.
 */
export function checkLock(
  date: string,
  locks: LockSettings,
  who: { actor: Actor; role: Role },
  note?: string | null,
): LockCheck {
  if (locks.hardLockDate && date <= locks.hardLockDate) {
    return {
      ok: false,
      code: "hard_locked",
      message: `The books are closed through ${locks.hardLockDate} (hard lock).`,
    };
  }
  if (locks.softLockDate && date <= locks.softLockDate) {
    if (who.actor === "user" && who.role === "owner") {
      if (note?.trim()) return { ok: true, overridesSoftLock: true };
      return {
        ok: false,
        code: "soft_locked",
        message: `The books are soft-locked through ${locks.softLockDate}. Owners can post with a note explaining why.`,
      };
    }
    return { ok: false, code: "soft_locked", message: `The books are locked through ${locks.softLockDate}.` };
  }
  return { ok: true, overridesSoftLock: false };
}

/** Normal balance sign: +1 for debit-normal accounts, -1 for credit-normal. */
export function normalSign(t: AccountType): 1 | -1 {
  return t === "asset" || t === "expense" ? 1 : -1;
}
