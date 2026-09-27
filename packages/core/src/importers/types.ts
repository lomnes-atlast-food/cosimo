/**
 * Normalized bundle produced by the QuickBooks Online / Xero / Wave importers (SPEC §14.2).
 * Parsing only: the server turns a bundle into accounts, contacts and posted journal entries
 * (`source_type: import`) after showing a dry-run report.
 *
 * Money is signed integer cents (debit positive, credit negative); dates are YYYY-MM-DD.
 */
import type { AccountSubtype, AccountType } from "@cosimo/shared";

export type ImportSource = "qbo" | "xero" | "wave";
export type ImportFileKind = "accounts" | "contacts" | "ledger";

export interface ImportFileInput {
  name: string;
  /** CSV text. */
  content: string;
}

export interface ImportedAccount {
  /**
   * Stable key used by lines to reference this account: the product's account number/code when present,
   * else the normalized full name (lowercased, whitespace collapsed, sub-account path segments joined with
   * ":", e.g. "utilities:internet"). For Wave, the export's Account ID when present.
   */
  key: string;
  /** Product account number/code, if any. */
  code: string | null;
  /** Leaf display name. For QBO "Parent:Child" this is "Child"; the parent is referenced by `parent`. */
  name: string;
  /** Parent account key when the product has sub-accounts (QBO). */
  parent: string | null;
  type: AccountType;
  subtype: AccountSubtype | null;
  description: string | null;
  /** The product's original type/detail label, for the report. */
  source_type_label: string;
  /** Full path as the product shows it, e.g. "Utilities:Internet" (QBO). */
  full_name?: string;
  /**
   * True when the account was not in any chart-of-accounts file and was created from a ledger reference.
   * Its type is a guess (see `guessAccountTypeFromName`) unless the ledger carried type information (Wave).
   */
  synthesized?: boolean;
}

export interface ImportedContact {
  name: string;
  kind: "customer" | "vendor" | "both";
  email: string | null;
  phone: string | null;
  company: string | null;
  is_1099_vendor?: boolean;
}

export interface ImportedLine {
  /** ImportedAccount.key */
  account: string;
  /** Signed cents: debit positive, credit negative. */
  amount: number;
  description: string | null;
  /** Contact name. */
  contact: string | null;
}

export interface ImportedEntry {
  date: string;
  reference: string | null;
  memo: string | null;
  /** e.g. "Invoice", "Bill Payment", "Receivable Payment". */
  source_label: string | null;
  lines: ImportedLine[];
  /** Product-side transaction identifier (Xero journal number, Wave transaction ID), for de-duplication. */
  external_id?: string | null;
  /** Source file name and 1-based CSV record number of the entry's first line. */
  file?: string;
  row?: number;
}

export interface ImportIssue {
  level: "error" | "warning";
  file: string;
  /** 1-based CSV record number (a quoted multi-line field counts as one record), or null. */
  row: number | null;
  message: string;
}

export interface ImportFileStat {
  name: string;
  kind: ImportFileKind | "unknown";
  /** Data rows read after the header (blank, total and footer rows excluded). */
  rows: number;
}

export interface ImportBundle {
  source: ImportSource;
  accounts: ImportedAccount[];
  contacts: ImportedContact[];
  entries: ImportedEntry[];
  issues: ImportIssue[];
  /** Summary for the dry-run report. */
  stats: {
    files: ImportFileStat[];
    date_range: { from: string; to: string } | null;
    /** Sum of all debit (positive) line amounts across emitted entries, in cents. */
    total_debits: number;
  };
}

export interface ImportDetection {
  source: ImportSource;
  kind: ImportFileKind;
}
