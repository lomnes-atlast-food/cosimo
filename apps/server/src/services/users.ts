import { newId, system } from "@cosimo/db";
import { minRole, type Role } from "@cosimo/shared";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { hashToken, randomToken, type SecretBox, TOKEN_PREFIX } from "../crypto.ts";
import type { SystemHandle } from "./types.ts";

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionPolicy {
  sessionDays: number;
  idleDays: number;
}

const DAY = 86_400_000;
let dummyHash: Promise<string> | null = null;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePassword(pw: string): void {
  if (pw.length < 10) throw new AuthError("weak_password", "Password must be at least 10 characters.");
  if (pw.length > 256) throw new AuthError("weak_password", "Password is too long.");
}

export class UserService {
  constructor(
    private readonly sys: SystemHandle,
    private readonly secrets: SecretBox,
    private readonly policy: SessionPolicy = { sessionDays: 30, idleDays: 7 },
  ) {}

  // ---------------------------------------------------------------- users

  async create(input: { email: string; name?: string; password?: string | null; isInstanceAdmin?: boolean }) {
    const email = normalizeEmail(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new AuthError("invalid_email", "Invalid email address.");
    if (input.password) validatePassword(input.password);
    const existing = await this.byEmail(email);
    if (existing) throw new AuthError("email_taken", "A user with that email already exists.");
    const id = newId();
    const passwordHash = input.password
      ? await Bun.password.hash(input.password, { algorithm: "argon2id" })
      : null;
    await this.sys.write((tx) =>
      tx.insert(system.users).values({
        id,
        email,
        name: input.name ?? "",
        passwordHash,
        isInstanceAdmin: input.isInstanceAdmin ?? false,
      }),
    );
    return (await this.byId(id))!;
  }

  byId(id: string) {
    return this.sys.db.select().from(system.users).where(eq(system.users.id, id)).get();
  }

  byEmail(email: string) {
    return this.sys.db
      .select()
      .from(system.users)
      .where(eq(system.users.email, normalizeEmail(email)))
      .get();
  }

  list() {
    return this.sys.db.select().from(system.users).all();
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  async setPassword(userId: string, password: string) {
    validatePassword(password);
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    await this.sys.write(async (tx) => {
      await tx.update(system.users).set({ passwordHash }).where(eq(system.users.id, userId));
      // Changing the password ends every other session.
      await tx.delete(system.sessions).where(eq(system.sessions.userId, userId));
    });
  }

  async setDisabled(userId: string, disabled: boolean) {
    await this.sys.write(async (tx) => {
      await tx
        .update(system.users)
        .set({ disabledAt: disabled ? new Date().toISOString() : null })
        .where(eq(system.users.id, userId));
      if (disabled) {
        await tx.delete(system.sessions).where(eq(system.sessions.userId, userId));
        await tx
          .update(system.apiTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(and(eq(system.apiTokens.userId, userId), isNull(system.apiTokens.revokedAt)));
      }
    });
  }

  async setAdmin(userId: string, isAdmin: boolean) {
    await this.sys.write((tx) =>
      tx.update(system.users).set({ isInstanceAdmin: isAdmin }).where(eq(system.users.id, userId)),
    );
  }

  async update(userId: string, patch: { name?: string }) {
    await this.sys.write((tx) => tx.update(system.users).set(patch).where(eq(system.users.id, userId)));
  }

  /** Verify credentials. Constant-ish time: always runs a hash verification. */
  async verifyLogin(email: string, password: string, totpCode?: string | null) {
    const user = await this.byEmail(email);
    // Always run a real verification so response time does not reveal whether the email exists.
    dummyHash ??= Bun.password.hash("cosimo-timing-equalizer", { algorithm: "argon2id" });
    const hash = user?.passwordHash ?? (await dummyHash);
    const ok = await Bun.password.verify(password, hash).catch(() => false);
    if (!user?.passwordHash || !ok || user.disabledAt) {
      throw new AuthError("invalid_credentials", "Invalid email or password.");
    }
    if (user.totpEnabled) {
      if (!totpCode) throw new AuthError("totp_required", "Two-factor code required.");
      if (!(await this.checkSecondFactor(user.id, totpCode))) {
        throw new AuthError("invalid_totp", "Invalid two-factor code.");
      }
    }
    return user;
  }

  // ---------------------------------------------------------------- sessions

  async createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null } = {}) {
    const token = randomToken(TOKEN_PREFIX.session);
    const now = Date.now();
    await this.sys.write((tx) =>
      tx.insert(system.sessions).values({
        id: hashToken(token),
        userId,
        createdAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.policy.sessionDays * DAY).toISOString(),
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        ip: meta.ip ?? null,
      }),
    );
    return { token, expiresAt: new Date(now + this.policy.sessionDays * DAY) };
  }

  async resolveSession(token: string) {
    const id = hashToken(token);
    const row = await this.sys.db
      .select({ session: system.sessions, user: system.users })
      .from(system.sessions)
      .innerJoin(system.users, eq(system.users.id, system.sessions.userId))
      .where(eq(system.sessions.id, id))
      .get();
    if (!row) return null;
    const now = Date.now();
    const idleLimit = Date.parse(row.session.lastSeenAt) + this.policy.idleDays * DAY;
    if (Date.parse(row.session.expiresAt) < now || idleLimit < now || row.user.disabledAt) {
      await this.sys.write((tx) => tx.delete(system.sessions).where(eq(system.sessions.id, id)));
      return null;
    }
    // Touch at most once a minute.
    if (now - Date.parse(row.session.lastSeenAt) > 60_000) {
      await this.sys.write((tx) =>
        tx
          .update(system.sessions)
          .set({ lastSeenAt: new Date(now).toISOString() })
          .where(eq(system.sessions.id, id)),
      );
    }
    return row;
  }

  async deleteSession(token: string) {
    await this.sys.write((tx) => tx.delete(system.sessions).where(eq(system.sessions.id, hashToken(token))));
  }

  async purgeExpiredSessions() {
    const now = new Date().toISOString();
    await this.sys.write((tx) => tx.delete(system.sessions).where(lt(system.sessions.expiresAt, now)));
  }

  // ---------------------------------------------------------------- claim links / password reset

  async issueClaimLink(userId: string, purpose: "claim" | "password_reset" = "claim", ttlHours = 24) {
    const token = randomToken("", 24);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
    await this.sys.write(async (tx) => {
      // Only the newest link of a purpose stays valid.
      await tx
        .update(system.claimLinks)
        .set({ usedAt: new Date().toISOString() })
        .where(
          and(
            eq(system.claimLinks.userId, userId),
            eq(system.claimLinks.purpose, purpose),
            isNull(system.claimLinks.usedAt),
          ),
        );
      await tx
        .insert(system.claimLinks)
        .values({ id: newId(), userId, tokenHash: hashToken(token), purpose, expiresAt });
    });
    return { token, expiresAt };
  }

  async peekClaimLink(token: string) {
    const row = await this.sys.db
      .select({ link: system.claimLinks, user: system.users })
      .from(system.claimLinks)
      .innerJoin(system.users, eq(system.users.id, system.claimLinks.userId))
      .where(
        and(
          eq(system.claimLinks.tokenHash, hashToken(token)),
          isNull(system.claimLinks.usedAt),
          gt(system.claimLinks.expiresAt, new Date().toISOString()),
        ),
      )
      .get();
    return row ?? null;
  }

  async consumeClaimLink(token: string, password: string) {
    validatePassword(password);
    const row = await this.peekClaimLink(token);
    if (!row) throw new AuthError("invalid_link", "This link is invalid, expired, or already used.");
    await this.sys.write((tx) =>
      tx
        .update(system.claimLinks)
        .set({ usedAt: new Date().toISOString() })
        .where(eq(system.claimLinks.id, row.link.id)),
    );
    await this.setPassword(row.user.id, password);
    return row.user;
  }

  // ---------------------------------------------------------------- TOTP

  async beginTotp(userId: string) {
    const user = await this.byId(userId);
    if (!user) throw new AuthError("not_found", "User not found");
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: "Cosimo", label: user.email, secret, digits: 6, period: 30 });
    await this.sys.write((tx) =>
      tx
        .update(system.users)
        .set({ totpSecretEnc: this.secrets.encrypt(secret.base32), totpEnabled: false })
        .where(eq(system.users.id, userId)),
    );
    return { secret: secret.base32, uri: totp.toString() };
  }

  private totpFor(secretB32: string) {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretB32), digits: 6, period: 30 });
  }

  async enableTotp(userId: string, code: string) {
    const user = await this.byId(userId);
    if (!user?.totpSecretEnc) throw new AuthError("totp_not_started", "Start two-factor setup first.");
    const secret = this.secrets.decrypt(user.totpSecretEnc);
    if (this.totpFor(secret).validate({ token: code.replace(/\s/g, ""), window: 1 }) === null) {
      throw new AuthError("invalid_totp", "Invalid two-factor code.");
    }
    const codes = Array.from({ length: 10 }, () =>
      randomToken("", 6).replace(/[-_]/g, "x").slice(0, 10).toLowerCase(),
    );
    await this.sys.write((tx) =>
      tx
        .update(system.users)
        .set({ totpEnabled: true, recoveryCodesJson: JSON.stringify(codes.map(hashToken)) })
        .where(eq(system.users.id, userId)),
    );
    return { recoveryCodes: codes };
  }

  async disableTotp(userId: string) {
    await this.sys.write((tx) =>
      tx
        .update(system.users)
        .set({ totpEnabled: false, totpSecretEnc: null, recoveryCodesJson: null })
        .where(eq(system.users.id, userId)),
    );
  }

  /** Accept a TOTP code or a one-time recovery code. */
  async checkSecondFactor(userId: string, code: string): Promise<boolean> {
    const user = await this.byId(userId);
    if (!user?.totpEnabled || !user.totpSecretEnc) return false;
    const clean = code.replace(/\s/g, "");
    if (/^\d{6}$/.test(clean)) {
      return (
        this.totpFor(this.secrets.decrypt(user.totpSecretEnc)).validate({ token: clean, window: 1 }) !== null
      );
    }
    const hashes: string[] = JSON.parse(user.recoveryCodesJson ?? "[]");
    const h = hashToken(clean.toLowerCase());
    if (!hashes.includes(h)) return false;
    await this.sys.write((tx) =>
      tx
        .update(system.users)
        .set({ recoveryCodesJson: JSON.stringify(hashes.filter((x) => x !== h)) })
        .where(eq(system.users.id, userId)),
    );
    return true;
  }

  // ---------------------------------------------------------------- API tokens

  async createApiToken(input: {
    userId: string;
    orgId: string;
    name: string;
    role: Role;
    userRole: Role;
    proposeOnly?: boolean;
  }) {
    const role = minRole(input.role, input.userRole);
    const token = randomToken(TOKEN_PREFIX.api);
    const id = newId();
    await this.sys.write((tx) =>
      tx.insert(system.apiTokens).values({
        id,
        userId: input.userId,
        orgId: input.orgId,
        name: input.name,
        tokenHash: hashToken(token),
        role,
        proposeOnly: input.proposeOnly ?? false,
      }),
    );
    return { id, token, role };
  }

  async resolveApiToken(token: string) {
    const row = await this.sys.db
      .select({ token: system.apiTokens, user: system.users })
      .from(system.apiTokens)
      .innerJoin(system.users, eq(system.users.id, system.apiTokens.userId))
      .where(and(eq(system.apiTokens.tokenHash, hashToken(token)), isNull(system.apiTokens.revokedAt)))
      .get();
    if (!row || row.user.disabledAt) return null;
    const last = row.token.lastUsedAt ? Date.parse(row.token.lastUsedAt) : 0;
    if (Date.now() - last > 60_000) {
      await this.sys.write((tx) =>
        tx
          .update(system.apiTokens)
          .set({ lastUsedAt: new Date().toISOString() })
          .where(eq(system.apiTokens.id, row.token.id)),
      );
    }
    return row;
  }

  listApiTokens(filter: { userId?: string; orgId?: string }) {
    const conds = [];
    if (filter.userId) conds.push(eq(system.apiTokens.userId, filter.userId));
    if (filter.orgId) conds.push(eq(system.apiTokens.orgId, filter.orgId));
    return this.sys.db
      .select({
        id: system.apiTokens.id,
        userId: system.apiTokens.userId,
        orgId: system.apiTokens.orgId,
        name: system.apiTokens.name,
        role: system.apiTokens.role,
        proposeOnly: system.apiTokens.proposeOnly,
        lastUsedAt: system.apiTokens.lastUsedAt,
        createdAt: system.apiTokens.createdAt,
        revokedAt: system.apiTokens.revokedAt,
      })
      .from(system.apiTokens)
      .where(conds.length ? and(...conds) : undefined)
      .all();
  }

  async revokeApiToken(id: string, byUserId?: string) {
    const conds = [eq(system.apiTokens.id, id)];
    if (byUserId) conds.push(eq(system.apiTokens.userId, byUserId));
    const tok = await this.sys.db
      .select()
      .from(system.apiTokens)
      .where(and(...conds))
      .get();
    if (!tok) return null;
    await this.sys.write((tx) =>
      tx
        .update(system.apiTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(system.apiTokens.id, id)),
    );
    return tok;
  }
}
