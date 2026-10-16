// src/gateway/tokens.ts
// Gateway-issued personal access tokens (PATs): `lzg_<id>_<secret>`.
// Only a SHA-256 hash of the secret is stored; the token itself is shown once, at creation.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { resolve } from "path";
import { fileMtimeMs, readPrivateJson, writePrivateJson } from "./private-file.js";

export interface UserIdentity {
  id: string;
  groups: string[];
  tokenId: string;
  /** May manage tokens, secrets and servers in the web UI. */
  admin: boolean;
}

interface StoredToken {
  user: string;
  groups: string[];
  hash: string;
  admin?: boolean;
  label?: string;
  createdAt: string;
  expiresAt?: string;
}

interface TokenFile {
  tokens: Record<string, StoredToken>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function parseDuration(spec: string): number {
  const m = /^(\d+)([smhd])$/.exec(spec.trim());
  if (!m) throw new Error(`Invalid duration "${spec}" (use e.g. 30m, 12h, 90d)`);
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

export class TokenStore {
  private data: TokenFile = { tokens: {} };
  private mtime = -1;
  readonly path: string;

  constructor(dir: string) {
    this.path = resolve(dir, "tokens.json");
  }

  /** Re-read when the file changed, so `token revoke` takes effect on a running gateway. */
  private load(): TokenFile {
    const m = fileMtimeMs(this.path);
    if (m !== this.mtime) {
      this.data = readPrivateJson<TokenFile>(this.path, { tokens: {} }, "token store");
      if (!this.data.tokens) this.data = { tokens: {} };
      this.mtime = m;
    }
    return this.data;
  }

  private save(): void {
    writePrivateJson(this.path, this.data);
    this.mtime = fileMtimeMs(this.path);
  }

  /** Returns the token — this is the only time it is available. */
  create(opts: { user: string; groups?: string[]; expiresInMs?: number; label?: string; admin?: boolean }): { id: string; token: string } {
    const data = this.load();
    const id = randomBytes(4).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    data.tokens[id] = {
      user: opts.user,
      groups: opts.groups ?? [],
      hash: sha256(secret),
      admin: opts.admin || undefined,
      label: opts.label,
      createdAt: new Date().toISOString(),
      expiresAt: opts.expiresInMs ? new Date(Date.now() + opts.expiresInMs).toISOString() : undefined,
    };
    this.save();
    return { id, token: `lzg_${id}_${secret}` };
  }

  verify(token: string | undefined): UserIdentity | null {
    if (!token) return null;
    const m = /^lzg_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/.exec(token);
    if (!m) return null;
    const entry = this.load().tokens[m[1]];
    if (!entry) return null;
    const a = Buffer.from(sha256(m[2]), "hex");
    const b = Buffer.from(entry.hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return null;
    return { id: entry.user, groups: entry.groups, tokenId: m[1], admin: entry.admin === true };
  }

  list(): Array<{ id: string; user: string; groups: string[]; admin: boolean; label?: string; createdAt: string; expiresAt?: string }> {
    return Object.entries(this.load().tokens).map(([id, t]) => ({
      id,
      user: t.user,
      groups: t.groups,
      admin: t.admin === true,
      label: t.label,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    }));
  }

  revoke(id: string): boolean {
    const data = this.load();
    if (!data.tokens[id]) return false;
    delete data.tokens[id];
    this.save();
    return true;
  }

  count(): number {
    return Object.keys(this.load().tokens).length;
  }
}

/** Extract the bearer token from an Authorization header value. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  const m = v ? /^Bearer\s+(\S+)$/i.exec(v) : null;
  return m?.[1];
}
