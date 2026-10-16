// src/gateway/audit.ts
// Append-only JSON-lines audit log. Records who called what — never arguments or results.

import { appendFileSync, mkdirSync } from "fs";
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

  record(e: AuditEvent): void {
    if (!this.path) return;
    try {
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error(`[lazygate] audit write failed: ${(err as Error).message}`);
    }
  }
}
