/**
 * The payment provider interface for online invoice payments (#55). Stripe is the first
 * implementation; the rest of Cosimo sees only these normalized shapes. Amounts are integer cents.
 */

export type PaymentMethodType = "card" | "us_bank_account" | "customer_balance";
export const PAYMENT_METHOD_TYPES = ["card", "us_bank_account", "customer_balance"] as const;

export interface ProviderAccount {
  accountName: string;
  livemode: boolean;
}

/** One permission the key needs. `ok` is null when Cosimo couldn't tell. */
export interface PermissionCheck {
  name: string;
  ok: boolean | null;
  /** The provider's message (IDs and URLs stripped), or why it couldn't be checked. */
  detail: string | null;
}

export type MethodStatus = "active" | "inactive" | "pending" | "unknown";

/** What a key can do in the provider account: the permissions Cosimo uses and each method's status. */
export interface SetupCheck {
  permissions: PermissionCheck[];
  methods: { type: PaymentMethodType; status: MethodStatus; detail: string | null }[];
  /**
   * For the webhook endpoint at the URL passed in: the events it doesn't send. Null when there is
   * no URL, no endpoint at it, or the key can't list endpoints.
   */
  missingEvents: string[] | null;
}

export interface CreateSessionInput {
  orgId: string;
  invoice: { id: string; number: string };
  /** What the customer pays now: the invoice's balance due. */
  amount: number;
  currency: string;
  customerId: string;
  methods: PaymentMethodType[];
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface ProviderSession {
  id: string;
  url: string;
  /** ISO timestamp. */
  expiresAt: string;
}

/** The authoritative state of a checkout session, as fetched from the provider. */
export type SessionResult =
  /** `url` is where the customer finishes paying; reused while the session is open. */
  | { kind: "open"; sessionId: string; invoiceId: string | null; url: string | null }
  | { kind: "payment_processing"; sessionId: string; invoiceId: string | null }
  | {
      kind: "payment_succeeded";
      sessionId: string;
      invoiceId: string | null;
      customerId: string | null;
      /** The provider's payment ID (Stripe: PaymentIntent), the idempotency key. */
      paymentId: string;
      gross: number;
      currency: string;
      /** Null until the provider has settled the fee (bank payments settle later). */
      fee: number | null;
      balanceTxnId: string | null;
      methodType: string | null;
      /** YYYY-MM-DD. */
      paidAt: string;
    }
  | { kind: "payment_failed"; sessionId: string; invoiceId: string | null }
  | { kind: "expired"; sessionId: string; invoiceId: string | null };

/** A verified webhook event, normalized. */
export type ProviderEvent =
  | { id: string; type: string; kind: "session"; sessionId: string }
  | { id: string; type: string; kind: "payment_intent"; paymentIntentId: string }
  /** A charge now has its balance transaction, so the fee is known. */
  | {
      id: string;
      type: string;
      kind: "charge";
      chargeId: string;
      paymentIntentId: string;
      balanceTxnId: string;
    }
  /** Refunds, disputes, payouts: stored for later processing; nothing is posted. */
  | { id: string; type: string; kind: "unhandled" }
  | { id: string; type: string; kind: "ignored" };

export interface PaymentProvider {
  readonly name: "stripe";
  testConnection(): Promise<ProviderAccount>;
  /**
   * Check the key's permissions and whether `methods` are active, without creating anything. Each
   * check that fails for another reason is reported as unknown rather than thrown.
   */
  checkSetup(methods: PaymentMethodType[], webhookUrl?: string | null): Promise<SetupCheck>;
  /**
   * Create the provider's customer for a contact. `idempotencyKey` overrides the per-contact key
   * (to replace a customer that no longer exists in the account).
   */
  ensureCustomer(
    contact: { id: string; name: string; email: string | null },
    idempotencyKey?: string,
  ): Promise<string>;
  createSession(input: CreateSessionInput): Promise<ProviderSession>;
  getSession(id: string): Promise<SessionResult>;
  /** Close an open session so it can't be paid any more. Fails when it already completed or expired. */
  expireSession(id: string): Promise<void>;
  /** The checkout session a payment belongs to (for events that name only the payment), or null. */
  sessionForPaymentIntent(paymentIntentId: string): Promise<string | null>;
  /** Fee for a payment once the provider has settled it, or null. */
  paymentFee(paymentId: string): Promise<{ fee: number; balanceTxnId: string } | null>;
  /** Fetch a past event again (retrying one whose processing failed). */
  fetchEvent(eventId: string): Promise<ProviderEvent>;
  /** Verify the signature and parse the event. Throws `WebhookSignatureError` when it fails. */
  verifyWebhook(signature: string | undefined, rawBody: string, now?: number): ProviderEvent;
  registerWebhook(url: string): Promise<{ id: string; secret: string }>;
  /** Set the events a registered endpoint sends. */
  updateWebhook(id: string, events: readonly string[]): Promise<void>;
  deleteWebhook(id: string): Promise<void>;
}

export class WebhookSignatureError extends Error {}

/** A provider API error. `status` is 0 for network failures; `param` names the rejected parameter. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

/**
 * Provider text that is stored or shown: account IDs, request IDs, keys, and URLs removed, so an
 * error message can't leak which account or request it came from.
 */
export function scrubProviderText(text: string): string {
  return (
    text
      .replace(/\s*\(https?:\/\/[^)]*\)/g, "")
      // Keep the sentence readable: "edit permissions at <url>" becomes "at the Stripe dashboard".
      .replace(/https?:\/\/dashboard\.stripe\.com\S*?(?=[.,;]?(?:\s|$))/g, "the Stripe dashboard")
      .replace(/https?:\/\/\S+?(?=[.,;]?(?:\s|$))/g, "Stripe's documentation")
      // Stripe masks keys in messages as rk_live_...AB12; drop the fragment too.
      .replace(/\b(?:sk|rk|pk)_(?:test|live)_[\w*.]+/g, "[key]")
      .replace(/\bwhsec_\w+/g, "[secret]")
      .replace(/\bacct_\w+/g, "[account]")
      .replace(/\s*\(?\b(?:request(?: id)?:?\s*)?req_\w+\)?/gi, "")
      .replace(/\s*;?\s*(?:see|visit)\s*\.?$/i, "")
      .replace(/\s+([.,;:])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}
