// src/gateway/audit.ts
// Append-only JSON-lines audit log. Records who called what — never arguments or results.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

export interface AuditEvent {
  user: string;
  session: string;
  /** Tool name as called by the client (meta-tool or proxied tool). */
  tool: string;
  server?: string;
  ok: boolean;
  ms: number;
  /** Short reason for failures (never contains credential values). */
  error?: string;
}

export class AuditLog {
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  /** Most recent events first; optionally only one user's. Reads the whole file — fine for a POC. */
  tail(limit: number, user?: string): Array<AuditEvent & { ts: string }> {
    if (!this.path || !existsSync(this.path)) return [];
    const out: Array<AuditEvent & { ts: string }> = [];
    const lines = readFileSync(this.path, "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]) as AuditEvent & { ts: string };
        if (!user || e.user === user) out.push(e);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }

  record(e: AuditEvent): void {
    if (!this.path) return;
    try {
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error(`[lazygate] audit write failed: ${(err as Error).message}`);
    }
  }
}
