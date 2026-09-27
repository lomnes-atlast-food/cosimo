/**
 * Minimal Plaid API client (SPEC §7.1) over fetch: only the endpoints Cosimo uses.
 * Tests replace it through `setPlaidFactory` with a scripted fake.
 */

export type PlaidEnv = "sandbox" | "production";

export interface PlaidCredentials {
  env: PlaidEnv;
  clientId: string;
  secret: string;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid sign: positive = money out of the account. */
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  original_description?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
}

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface LinkTokenRequest {
  userId: string;
  clientName: string;
  webhook?: string | null;
  redirectUri?: string | null;
  /** Update mode (reauthentication) for an existing item. */
  accessToken?: string | null;
}

export interface Jwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  y: string;
  alg?: string;
  use?: string;
  created_at?: number;
  expired_at?: number | null;
}

export interface PlaidApi {
  linkTokenCreate(r: LinkTokenRequest): Promise<{ link_token: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<{ access_token: string; item_id: string }>;
  accountsGet(accessToken: string): Promise<{ accounts: PlaidAccount[]; institution_id: string | null }>;
  institutionName(institutionId: string): Promise<string | null>;
  transactionsSync(accessToken: string, cursor: string | null): Promise<SyncPage>;
  itemRemove(accessToken: string): Promise<void>;
  itemWebhookUpdate(accessToken: string, webhook: string): Promise<void>;
  webhookVerificationKey(keyId: string): Promise<Jwk>;
  /** Cheap authenticated call used by `cosimo doctor` to confirm the keys work. */
  checkCredentials(): Promise<void>;
  sandboxPublicToken(institutionId: string): Promise<string>;
  sandboxResetLogin(accessToken: string): Promise<void>;
}

/** A Plaid API error. `code` is Plaid's `error_code` (e.g. ITEM_LOGIN_REQUIRED). */
export class PlaidError extends Error {
  constructor(
    readonly code: string,
    readonly type: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/** Plaid error codes that mean the user must go through Link update mode. */
export const REAUTH_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "ITEM_LOCKED",
  "USER_SETUP_REQUIRED",
  "INSUFFICIENT_CREDENTIALS",
  "ACCESS_NOT_GRANTED",
  "NO_ACCOUNTS",
]);

const HOSTS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class HttpPlaid implements PlaidApi {
  constructor(
    private readonly creds: PlaidCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${HOSTS[this.creds.env]}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "plaid-version": "2020-09-14",
          "plaid-client-id": this.creds.clientId,
          "plaid-secret": this.creds.secret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new PlaidError("NETWORK_ERROR", "API_ERROR", `Could not reach Plaid: ${(e as Error).message}`, 0);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaidError(
        String(data.error_code ?? "UNKNOWN"),
        String(data.error_type ?? "API_ERROR"),
        String(data.display_message ?? data.error_message ?? `Plaid returned HTTP ${res.status}`),
        res.status,
        data.request_id ? String(data.request_id) : undefined,
      );
    }
    return data as T;
  }

  async linkTokenCreate(r: LinkTokenRequest) {
    const body: Record<string, unknown> = {
      client_name: r.clientName.slice(0, 30),
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: r.userId },
    };
    if (r.webhook) body.webhook = r.webhook;
    if (r.redirectUri) body.redirect_uri = r.redirectUri;
    if (r.accessToken) body.access_token = r.accessToken;
    else {
      body.products = ["transactions"];
      body.transactions = { days_requested: 730 };
    }
    return this.call<{ link_token: string; expiration: string }>("/link/token/create", body);
  }

  exchangePublicToken(publicToken: string) {
    return this.call<{ access_token: string; item_id: string }>("/item/public_token/exchange", {
      public_token: publicToken,
    });
  }

  async accountsGet(accessToken: string) {
    const r = await this.call<{ accounts: PlaidAccount[]; item: { institution_id?: string | null } }>(
      "/accounts/get",
      { access_token: accessToken },
    );
    return { accounts: r.accounts, institution_id: r.item?.institution_id ?? null };
  }

  async institutionName(institutionId: string) {
    const r = await this.call<{ institution: { name: string } }>("/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US"],
    });
    return r.institution?.name ?? null;
  }

  transactionsSync(accessToken: string, cursor: string | null) {
    const body: Record<string, unknown> = { access_token: accessToken, count: 500 };
    if (cursor) body.cursor = cursor;
    return this.call<SyncPage>("/transactions/sync", body);
  }

  async itemRemove(accessToken: string) {
    await this.call("/item/remove", { access_token: accessToken });
  }

  async itemWebhookUpdate(accessToken: string, webhook: string) {
    await this.call("/item/webhook/update", { access_token: accessToken, webhook });
  }

  async webhookVerificationKey(keyId: string) {
    const r = await this.call<{ key: Jwk }>("/webhook_verification_key/get", { key_id: keyId });
    return r.key;
  }

  async checkCredentials() {
    await this.call("/institutions/get", { count: 1, offset: 0, country_codes: ["US"] });
  }

  async sandboxPublicToken(institutionId: string) {
    const r = await this.call<{ public_token: string }>("/sandbox/public_token/create", {
      institution_id: institutionId,
      initial_products: ["transactions"],
    });
    return r.public_token;
  }

  async sandboxResetLogin(accessToken: string) {
    await this.call("/sandbox/item/reset_login", { access_token: accessToken });
  }
}

type Factory = (creds: PlaidCredentials) => PlaidApi;
let factory: Factory = (creds) => new HttpPlaid(creds);

export function plaidClient(creds: PlaidCredentials): PlaidApi {
  return factory(creds);
}

/** Tests: swap the client implementation. Returns a restore function. */
export function setPlaidFactory(f: Factory): () => void {
  const prev = factory;
  factory = f;
  return () => {
    factory = prev;
  };
}
