// src/gateway/vault.ts
// Per-user credentials entered through the web UI, encrypted at rest (AES-256-GCM).
// The key comes from LAZYGATE_VAULT_KEY (base64, 32 bytes) or a 0600 `vault.key` next to the data.
// Each value is bound to its user/server/field, so a stored value can't be moved to another user.
// Credentials sent as request headers always take precedence over stored ones.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ensurePrivateMode, fileMtimeMs, readPrivateJson, writePrivateJson } from "./private-file.js";
import type { UserCredentials } from "./credentials.js";

type VaultFile = Record<string, Record<string, Record<string, string>>>;

export class UserVault {
  private data: VaultFile = {};
  private mtime = -1;
  private key?: Buffer;
  readonly path: string;
  private readonly keyPath: string;

  constructor(
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.path = resolve(dir, "vault.json");
    this.keyPath = resolve(dir, "vault.key");
  }

  private getKey(): Buffer {
    if (this.key) return this.key;
    const fromEnv = this.env.LAZYGATE_VAULT_KEY;
    let key: Buffer;
    if (fromEnv) {
      key = Buffer.from(fromEnv, "base64");
    } else if (existsSync(this.keyPath)) {
      key = Buffer.from(readFileSync(this.keyPath, "utf-8").trim(), "base64");
    } else {
      key = randomBytes(32);
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.keyPath, key.toString("base64") + "\n", { mode: 0o600 });
      ensurePrivateMode(this.keyPath);
    }
    if (key.length !== 32) throw new Error("Vault key must be 32 bytes (base64)");
    this.key = key;
    return key;
  }

  private load(): VaultFile {
    const m = fileMtimeMs(this.path);
    if (m !== this.mtime) {
      this.data = readPrivateJson<VaultFile>(this.path, {}, "credential vault");
      this.mtime = m;
    }
    return this.data;
  }

  private seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.getKey(), iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf-8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }

  private open(sealed: string, aad: string): string | undefined {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct) return undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf-8");
    } catch {
      return undefined; // wrong key or tampered
    }
  }

  private static aad = (user: string, server: string, field: string) => `${user}\0${server}\0${field}`;

  /** All stored credentials for a user, decrypted (field names lower-case). */
  get(user: string): UserCredentials {
    const out: UserCredentials = new Map();
    const mine = this.load()[user];
    if (!mine) return out;
    for (const [server, fields] of Object.entries(mine)) {
      const plain: Record<string, string> = {};
      for (const [field, sealed] of Object.entries(fields)) {
        const v = this.open(sealed, UserVault.aad(user, server, field));
        if (v !== undefined) plain[field] = v;
      }
      if (Object.keys(plain).length) out.set(server, plain);
    }
    return out;
  }

  /** Which fields are stored per server — never the values. */
  list(user: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [server, fields] of Object.entries(this.load()[user] ?? {})) out[server] = Object.keys(fields).sort();
    return out;
  }

  set(user: string, server: string, field: string, value: string): void {
    const f = field.toLowerCase();
    const all = structuredClone(this.load());
    ((all[user] ??= {})[server] ??= {})[f] = this.seal(value, UserVault.aad(user, server, f));
    writePrivateJson(this.path, all);
    this.mtime = -1;
  }

  delete(user: string, server: string, field: string): boolean {
    const f = field.toLowerCase();
    const all = structuredClone(this.load());
    if (!all[user]?.[server]?.[f]) return false;
    delete all[user][server][f];
    if (!Object.keys(all[user][server]).length) delete all[user][server];
    if (!Object.keys(all[user]).length) delete all[user];
    writePrivateJson(this.path, all);
    this.mtime = -1;
    return true;
  }
}

/** Header-sent credentials win over stored ones, field by field. */
export function mergeCreds(stored: UserCredentials, sent: UserCredentials): UserCredentials {
  const out: UserCredentials = new Map();
  for (const src of [stored, sent]) {
    for (const [server, fields] of src) out.set(server, { ...(out.get(server) ?? {}), ...fields });
  }
  return out;
}
