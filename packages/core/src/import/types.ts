export interface ParsedTxn {
  /** YYYY-MM-DD */
  date: string;
  /** Integer cents, signed from the account holder's perspective: positive = money in. */
  amount: number;
  /** Raw description (OFX: NAME + MEMO joined). */
  description: string;
  /** Best-effort payee (OFX NAME; CSV payee column if mapped). */
  payee: string | null;
  /** OFX FITID; null for CSV. */
  providerId: string | null;
  /** 1-based source row / transaction index for error reporting. */
  row: number;
}

export interface ParseError {
  row: number;
  message: string;
}

export interface ParseResult {
  rows: ParsedTxn[];
  errors: ParseError[];
  account?: {
    bankId?: string | null;
    accountId?: string | null;
    accountType?: string | null;
    currency?: string | null;
  };
  ledgerBalance?: { amount: number; date: string } | null;
}

export type AmountMode = "signed" | "debit_credit" | "amount_type";
export type SignConvention = "positive_is_deposit" | "positive_is_withdrawal";

export const DATE_FORMATS = [
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "M/D/YY",
  "D/M/YY",
  "YYYYMMDD",
  "DD.MM.YYYY",
  "MMM D, YYYY",
  "YYYY/MM/DD",
  "MM-DD-YYYY",
  "DD-MM-YYYY",
  "D MMM YYYY",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DEFAULT_OUTFLOW_TYPES = ["debit", "dr", "withdrawal", "d", "payment", "out"];

export interface CsvProfile {
  hasHeader: boolean;
  /** Rows to skip before the header/data. */
  skipRows: number;
  /** Auto-detected when null/undefined. */
  delimiter?: string | null;
  dateFormat: DateFormat;
  amountMode: AmountMode;
  /** Applies to "signed" and "amount_type" amount column values. */
  signConvention: SignConvention;
  /** Zero-based column indexes. */
  columns: {
    date: number;
    description: number;
    /** signed / amount_type */
    amount?: number | null;
    /** debit_credit: money out */
    debit?: number | null;
    /** debit_credit: money in */
    credit?: number | null;
    /** amount_type: e.g. "DEBIT"/"CREDIT", "DR"/"CR", "withdrawal"/"deposit" */
    type?: number | null;
    payee?: number | null;
    /** Appended to description when present. */
    memo?: number | null;
  };
  /** amount_type: values (case-insensitive) meaning money out. Default DEFAULT_OUTFLOW_TYPES. */
  outflowTypes?: string[];
}
