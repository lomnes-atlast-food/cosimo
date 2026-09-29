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
  /** Refunds, disputes, payouts: stored for later processing; nothing is posted. */
  | { id: string; type: string; kind: "unhandled" }
  | { id: string; type: string; kind: "ignored" };

export interface PaymentProvider {
  readonly name: "stripe";
  testConnection(): Promise<ProviderAccount>;
  /** Create the provider's customer for a contact. */
  ensureCustomer(contact: { id: string; name: string; email: string | null }): Promise<string>;
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
  deleteWebhook(id: string): Promise<void>;
}

export class WebhookSignatureError extends Error {}

/** A provider API error. `status` is 0 for network failures. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
