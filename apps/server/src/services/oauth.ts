/**
 * OAuth 2.1 authorization server for AI clients (SPEC §10.4, MCP authorization spec).
 *
 * - Dynamic client registration (RFC 7591) unless an instance admin turns it off; admins can also
 *   register clients manually, which issues a client secret.
 * - Authorization code flow with PKCE (S256 only). Codes last 10 minutes and are single-use.
 * - Access tokens last 1 hour; refresh tokens last 30 days and rotate on every use.
 * - Every grant is for one org with a role capped at the user's own role. OAuth callers act as the
 *   `mcp` actor and are always propose-only, so their writes go to the review queue.
 * - Codes, tokens, and client secrets are stored as SHA-256 hashes.
 * - Redirect URIs match exactly. `http://` is allowed only for loopback hosts (any port).
 */
import { createHash } from "node:crypto";
import { newId, system } from "@cosimo/db";
import { minRole, type Role, roleAtLeast } from "@cosimo/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { hashToken, randomToken, safeEqual, TOKEN_PREFIX } from "../crypto.ts";
import type { Principal } from "../http/types.ts";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
export const CODE_TTL_S = 600;
export const OAUTH_SCOPE = "books";

/** RFC 6749 error, rendered as `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status: 400 | 401 | 403 = 400,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A redirect URI must be absolute, https (or http on loopback), and have no fragment. */
export function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  // Native apps may use private-use schemes (RFC 8252 §7.1), e.g. com.example.app:/callback.
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== "http:" || !LOOPBACK.has(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === "http:" &&
        u.hostname === g.hostname &&
        u.pathname === g.pathname &&
        u.search === g.search
      );
    } catch {
      return false;
    }
  });
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export class OAuthService {
  constructor(private ctx: AppContext) {}

  get issuer() {
    return this.ctx.config.server.public_url.replace(/\/$/, "");
  }
  get resource() {
    return `${this.issuer}/mcp`;
  }

  // -------------------------------------------------------------------------- clients

  async registerClient(input: {
    client_name?: string;
    redirect_uris?: unknown;
    via: "dynamic" | "manual";
    createdBy?: string | null;
    confidential?: boolean;
  }) {
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [];
    if (!uris.length) throw new OAuthError("invalid_redirect_uri", "At least one redirect_uri is required.");
    if (uris.length > 10) throw new OAuthError("invalid_redirect_uri", "Too many redirect URIs.");
    for (const u of uris)
      if (!validRedirectUri(u))
        throw new OAuthError(
          "invalid_redirect_uri",
          `Redirect URI ${u} must use https (http is allowed only for localhost) and have no fragment.`,
        );
    const name = (input.client_name ?? "").trim().slice(0, 100) || "Unnamed client";
    const id = `cosimo_oci_${newId().toLowerCase()}`;
    const secret = input.confidential ? randomToken(TOKEN_PREFIX.clientSecret) : null;
    await this.ctx.system.write((tx) =>
      tx.insert(system.oauthClients).values({
        id,
        clientName: name,
        redirectUrisJson: JSON.stringify(uris),
        registeredVia: input.via,
        clientSecretHash: secret ? hashToken(secret) : null,
        createdBy: input.createdBy ?? null,
      }),
    );
    return { client_id: id, client_secret: secret, client_name: name, redirect_uris: uris };
  }

  async getClient(id: string) {
    const c = await this.ctx.system.db
      .select()
      .from(system.oauthClients)
      .where(eq(system.oauthClients.id, id))
      .get();
    if (!c || c.revokedAt) return null;
    return { ...c, redirectUris: JSON.parse(c.redirectUrisJson) as string[] };
  }

  listClients() {
    return this.ctx.system.db
      .select()
      .from(system.oauthClients)
      .orderBy(desc(system.oauthClients.createdAt))
      .all();
  }

  async revokeClient(id: string) {
    const now = new Date().toISOString();
    await this.ctx.system.write(async (tx) => {
      await tx.update(system.oauthClients).set({ revokedAt: now }).where(eq(system.oauthClients.id, id));
      await tx
        .update(system.oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(system.oauthTokens.clientId, id), isNull(system.oauthTokens.revokedAt)));
    });
  }

  // -------------------------------------------------------------------------- authorize

  /**
   * Validate an authorization request. Client and redirect problems throw with `redirect: false`
   * (never redirect to an unverified URI); other problems are reported to the redirect URI.
   */
  async checkAuthorize(q: AuthorizeRequest) {
    const client = q.client_id ? await this.getClient(q.client_id) : null;
    if (!client)
      return { ok: false as const, redirect: false, error: "invalid_client", message: "Unknown client." };
    if (!q.redirect_uri || !redirectMatches(client.redirectUris, q.redirect_uri))
      return {
        ok: false as const,
        redirect: false,
        error: "invalid_request",
        message: "The redirect URI does not match the one registered for this client.",
      };
    const fail = (error: string, message: string) => ({
      ok: false as const,
      redirect: true,
      error,
      message,
      client,
    });
    if (q.response_type !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!q.code_challenge || q.code_challenge_method !== "S256")
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge))
      return fail("invalid_request", "code_challenge must be a base64url SHA-256 value.");
    if (
      q.resource &&
      q.resource.replace(/\/$/, "") !== this.resource &&
      q.resource.replace(/\/$/, "") !== this.issuer
    )
      return fail("invalid_target", `Unknown resource. Use ${this.resource}.`);
    return { ok: true as const, client };
  }

  errorRedirect(redirectUri: string, error: string, message: string, state?: string) {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", message);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", this.issuer);
    return u.toString();
  }

  /** The signed-in user approved: issue a code for one org with a role capped at theirs. */
  async approve(q: AuthorizeRequest, userId: string, orgId: string, requested: Role) {
    const check = await this.checkAuthorize(q);
    if (!check.ok) throw new OAuthError(check.error, check.message);
    const member = await this.ctx.orgs.membership(userId, orgId);
    if (!member) throw new OAuthError("access_denied", "You are not a member of that organization.", 403);
    const role = minRole(requested, member);
    const code = randomToken(TOKEN_PREFIX.oauthCode);
    await this.ctx.system.write((tx) =>
      tx.insert(system.oauthCodes).values({
        codeHash: hashToken(code),
        clientId: q.client_id,
        userId,
        orgId,
        role,
        scope: OAUTH_SCOPE,
        codeChallenge: q.code_challenge!,
        redirectUri: q.redirect_uri,
        resource: q.resource ?? null,
        expiresAt: iso(CODE_TTL_S * 1000),
      }),
    );
    const u = new URL(q.redirect_uri);
    u.searchParams.set("code", code);
    if (q.state) u.searchParams.set("state", q.state);
    u.searchParams.set("iss", this.issuer);
    return { redirect_to: u.toString(), role };
  }

  // -------------------------------------------------------------------------- token

  private async authenticateClient(clientId: string, secret: string | null) {
    const client = await this.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown or revoked client.", 401);
    if (client.clientSecretHash) {
      if (!secret || !safeEqual(hashToken(secret), client.clientSecretHash))
        throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
    return client;
  }

  private async issue(
    tx: Parameters<Parameters<AppContext["system"]["write"]>[0]>[0],
    grant: { clientId: string; userId: string; orgId: string; role: Role; scope: string },
    existingId?: string,
  ) {
    const access = randomToken(TOKEN_PREFIX.oauthAccess);
    const refresh = randomToken(TOKEN_PREFIX.oauthRefresh);
    const values = {
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refresh),
      accessExpiresAt: iso(ACCESS_TTL_S * 1000),
      refreshExpiresAt: iso(REFRESH_TTL_S * 1000),
    };
    if (existingId) {
      await tx.update(system.oauthTokens).set(values).where(eq(system.oauthTokens.id, existingId));
    } else {
      await tx.insert(system.oauthTokens).values({ id: newId(), ...grant, ...values });
    }
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: grant.scope,
    };
  }

  async exchangeCode(p: {
    code?: string;
    redirect_uri?: string;
    client_id?: string;
    client_secret?: string | null;
    code_verifier?: string;
  }) {
    if (!p.code || !p.client_id || !p.code_verifier || !p.redirect_uri)
      throw new OAuthError(
        "invalid_request",
        "code, client_id, redirect_uri and code_verifier are required.",
      );
    await this.authenticateClient(p.client_id, p.client_secret ?? null);
    const h = hashToken(p.code);
    const out = await this.ctx.system.write(async (tx) => {
      const row = await tx.select().from(system.oauthCodes).where(eq(system.oauthCodes.codeHash, h)).get();
      if (!row || row.clientId !== p.client_id)
        throw new OAuthError("invalid_grant", "The authorization code is invalid.");
      if (row.usedAt) {
        // A replayed code: revoke whatever it produced (RFC 6749 §4.1.2).
        await tx
          .update(system.oauthTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(
            and(
              eq(system.oauthTokens.clientId, row.clientId),
              eq(system.oauthTokens.userId, row.userId),
              eq(system.oauthTokens.orgId, row.orgId),
              gt(
                system.oauthTokens.createdAt,
                new Date(Date.parse(row.expiresAt) - CODE_TTL_S * 1000).toISOString(),
              ),
            ),
          );
        // Commit the revocation, then report the error (throwing here would roll it back).
        return null;
      }
      if (Date.parse(row.expiresAt) < Date.now())
        throw new OAuthError("invalid_grant", "The authorization code expired.");
      if (row.redirectUri !== p.redirect_uri)
        throw new OAuthError("invalid_grant", "redirect_uri does not match.");
      if (!safeEqual(pkceChallenge(p.code_verifier!), row.codeChallenge))
        throw new OAuthError("invalid_grant", "PKCE verification failed.");
      await tx
        .update(system.oauthCodes)
        .set({ usedAt: new Date().toISOString() })
        .where(eq(system.oauthCodes.codeHash, h));
      const member = await this.ctx.orgs.membership(row.userId, row.orgId);
      if (!member)
        throw new OAuthError("invalid_grant", "The user is no longer a member of that organization.");
      return this.issue(tx, {
        clientId: row.clientId,
        userId: row.userId,
        orgId: row.orgId,
        role: minRole(row.role, member),
        scope: row.scope,
      });
    });
    if (!out) throw new OAuthError("invalid_grant", "The authorization code was already used.");
    return out;
  }

  async refresh(p: { refresh_token?: string; client_id?: string; client_secret?: string | null }) {
    if (!p.refresh_token || !p.client_id)
      throw new OAuthError("invalid_request", "refresh_token and client_id are required.");
    await this.authenticateClient(p.client_id, p.client_secret ?? null);
    const h = hashToken(p.refresh_token);
    return this.ctx.system.write(async (tx) => {
      const row = await tx
        .select()
        .from(system.oauthTokens)
        .where(eq(system.oauthTokens.refreshTokenHash, h))
        .get();
      if (!row || row.clientId !== p.client_id || row.revokedAt)
        throw new OAuthError("invalid_grant", "The refresh token is invalid or was revoked.");
      if (!row.refreshExpiresAt || Date.parse(row.refreshExpiresAt) < Date.now())
        throw new OAuthError("invalid_grant", "The refresh token expired. Connect again.");
      const member = await this.ctx.orgs.membership(row.userId, row.orgId);
      if (!member)
        throw new OAuthError("invalid_grant", "The user is no longer a member of that organization.");
      return this.issue(
        tx,
        {
          clientId: row.clientId,
          userId: row.userId,
          orgId: row.orgId,
          role: minRole(row.role, member),
          scope: row.scope,
        },
        row.id,
      );
    });
  }

  /** RFC 7009: revoke by access or refresh token. Unknown tokens are not an error. */
  async revokeToken(token: string, clientId?: string) {
    const h = hashToken(token);
    const col = token.startsWith(TOKEN_PREFIX.oauthRefresh)
      ? system.oauthTokens.refreshTokenHash
      : system.oauthTokens.accessTokenHash;
    await this.ctx.system.write(async (tx) => {
      const row = await tx.select().from(system.oauthTokens).where(eq(col, h)).get();
      if (!row || (clientId && row.clientId !== clientId)) return;
      await tx
        .update(system.oauthTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(system.oauthTokens.id, row.id));
    });
  }

  // -------------------------------------------------------------------------- resource server

  async resolveAccessToken(token: string): Promise<Principal | null> {
    const row = await this.ctx.system.db
      .select({ t: system.oauthTokens, u: system.users, c: system.oauthClients })
      .from(system.oauthTokens)
      .innerJoin(system.users, eq(system.users.id, system.oauthTokens.userId))
      .innerJoin(system.oauthClients, eq(system.oauthClients.id, system.oauthTokens.clientId))
      .where(eq(system.oauthTokens.accessTokenHash, hashToken(token)))
      .get();
    if (!row || row.t.revokedAt || row.c.revokedAt || row.u.disabledAt) return null;
    if (Date.parse(row.t.accessExpiresAt) < Date.now()) return null;
    const last = row.t.lastUsedAt ? Date.parse(row.t.lastUsedAt) : 0;
    if (Date.now() - last > 60_000)
      await this.ctx.system.write((tx) =>
        tx
          .update(system.oauthTokens)
          .set({ lastUsedAt: new Date().toISOString() })
          .where(eq(system.oauthTokens.id, row.t.id)),
      );
    return {
      kind: "oauth",
      userId: row.u.id,
      email: row.u.email,
      name: row.u.name,
      isInstanceAdmin: false,
      oauthTokenId: row.t.id,
      oauthClientId: row.c.id,
      orgId: row.t.orgId,
      roleCap: row.t.role,
      proposeOnly: true,
    };
  }

  // -------------------------------------------------------------------------- connections

  /** Active grants, for a user's own list or an owner's view of an org. */
  async connections(filter: { userId?: string; orgId?: string }) {
    const conds = [
      isNull(system.oauthTokens.revokedAt),
      gt(system.oauthTokens.refreshExpiresAt, new Date().toISOString()),
    ];
    if (filter.userId) conds.push(eq(system.oauthTokens.userId, filter.userId));
    if (filter.orgId) conds.push(eq(system.oauthTokens.orgId, filter.orgId));
    const rows = await this.ctx.system.db
      .select({ t: system.oauthTokens, c: system.oauthClients, u: system.users, o: system.organizations })
      .from(system.oauthTokens)
      .innerJoin(system.oauthClients, eq(system.oauthClients.id, system.oauthTokens.clientId))
      .innerJoin(system.users, eq(system.users.id, system.oauthTokens.userId))
      .innerJoin(system.organizations, eq(system.organizations.id, system.oauthTokens.orgId))
      .where(and(...conds, isNull(system.oauthClients.revokedAt)))
      .orderBy(desc(system.oauthTokens.createdAt))
      .all();
    return rows.map((r) => ({
      id: r.t.id,
      client_id: r.c.id,
      client_name: r.c.clientName,
      user_id: r.u.id,
      user_email: r.u.email,
      org_id: r.o.id,
      org_name: r.o.name,
      role: r.t.role,
      created_at: r.t.createdAt,
      last_used_at: r.t.lastUsedAt,
    }));
  }

  async getGrant(id: string) {
    return this.ctx.system.db.select().from(system.oauthTokens).where(eq(system.oauthTokens.id, id)).get();
  }

  async revokeGrant(id: string) {
    await this.ctx.system.write((tx) =>
      tx
        .update(system.oauthTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(system.oauthTokens.id, id)),
    );
  }

  /** Roles a user may grant for an org: at most their own. */
  static grantableRoles(member: Role): Role[] {
    return (["owner", "bookkeeper", "accountant", "viewer"] as Role[]).filter((r) => roleAtLeast(member, r));
  }
}
