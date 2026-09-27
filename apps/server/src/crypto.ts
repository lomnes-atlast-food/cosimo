/**
 * Master-key encryption (AES-256-GCM) and token helpers (SPEC §12).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PREFIX = "enc:v1:";

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function parseMasterKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) throw new Error("Master key must be 32 bytes, base64 encoded");
  return key;
}

export class SecretBox {
  readonly #key: Buffer;
  constructor(masterKeyB64: string) {
    this.#key = parseMasterKey(masterKeyB64);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64url")}:${Buffer.concat([ct, tag]).toString("base64url")}`;
  }

  decrypt(value: string): string {
    if (!value.startsWith(PREFIX)) throw new Error("Not an encrypted value");
    const [ivB64, dataB64] = value.slice(PREFIX.length).split(":");
    if (!ivB64 || !dataB64) throw new Error("Malformed encrypted value");
    const data = Buffer.from(dataB64, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString(
      "utf8",
    );
  }

  /** Decrypt if encrypted, otherwise return as-is (values supplied through env are plaintext). */
  reveal(value: string | null | undefined): string | null {
    if (value == null || value === "") return null;
    return isEncrypted(value) ? this.decrypt(value) : value;
  }

  hmac(data: string): string {
    return createHmac("sha256", this.#key).update(data).digest("base64url");
  }
}

export function isEncrypted(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(PREFIX);
}

export function randomToken(prefix = "", bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const TOKEN_PREFIX = {
  api: "cosimo_pat_",
  oauthAccess: "cosimo_oat_",
  oauthRefresh: "cosimo_ort_",
  oauthCode: "cosimo_oac_",
  claim: "",
  invite: "",
  session: "",
  clientSecret: "cosimo_ocs_",
} as const;
