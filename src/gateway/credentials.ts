// src/gateway/credentials.ts
// Credential resolution for gateway mode.
//
//  • User-level credentials arrive as request headers:  X-Lazygate-Cred-<Server>-<Field>: <value>
//  • Server-level credentials live in the gateway's secret store (secrets.json / environment).
//  • Servers reference them as `${cred:field}` and `${secret:path}` templates in `auth.env` /
//    `auth.headers`; the result is handed to ProcessManager as RuntimeCredentials.

import { resolve } from "path";
import type { ServerConfig } from "../router.js";
import type { RuntimeCredentials } from "../process-manager.js";
import { fileMtimeMs, readPrivateJson, writePrivateJson, ensurePrivateMode } from "./private-file.js";

export const CRED_HEADER_PREFIX = "x-lazygate-cred-";

/** Credentials a user sent, grouped by server then field (field names lower-cased). */
export type UserCredentials = Map<string, Record<string, string>>;

export interface CallerIdentity {
  id: string;
  groups: string[];
}

export class MissingCredentialError extends Error {
  constructor(
    readonly server: string,
    readonly needs: string[]
  ) {
    super(
      `Server "${server}" needs credentials. Send ${needs.length > 1 ? "these headers" : "this header"} ` +
        `with your MCP requests: ${needs.join(", ")}`
    );
    this.name = "MissingCredentialError";
  }
}

/** `jira` + `token` → `X-Lazygate-Cred-jira-token` (the case users see in error messages). */
export function credHeaderName(server: string, field: string): string {
  return `X-Lazygate-Cred-${server}-${field}`;
}

/**
 * Collect user credentials from request headers. Server names can contain hyphens, so the header
 * suffix is matched against the configured server names (longest match wins); anything that
 * doesn't match a configured server is ignored.
 */
export function extractUserCreds(
  headers: Record<string, string | string[] | undefined>,
  serverNames: string[]
): UserCredentials {
  const byLength = [...serverNames].sort((a, b) => b.length - a.length);
  const out: UserCredentials = new Map();
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!key.startsWith(CRED_HEADER_PREFIX)) continue;
    const value = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    if (!value) continue;
    const rest = key.slice(CRED_HEADER_PREFIX.length);
    const server = byLength.find((n) => rest.startsWith(`${n.toLowerCase()}-`));
    if (!server) continue;
    const field = rest.slice(server.length + 1);
    if (!field) continue;
    const fields = out.get(server) ?? {};
    fields[field] = value;
    out.set(server, fields);
  }
  return out;
}

// ─── Secret store (server-level credentials) ───────────────────────────────

/** `datadog/api_key` → `LAZYGATE_SECRET_DATADOG_API_KEY` */
export function secretEnvName(path: string): string {
  return `LAZYGATE_SECRET_${path.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Server-level secrets: `<dir>/secrets.json` (a flat `{ "path": "value" }` map, 0600) with
 * `LAZYGATE_SECRET_<PATH>` environment variables taking precedence. Re-read when the file changes.
 */
export class SecretStore {
  private cache: Record<string, string> = {};
  private mtime = -1;
  readonly path: string;

  constructor(
    dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.path = resolve(dir, "secrets.json");
  }

  private load(): Record<string, string> {
    const m = fileMtimeMs(this.path);
    if (m !== this.mtime) {
      this.cache = readPrivateJson<Record<string, string>>(this.path, {}, "secret store");
      this.mtime = m;
    }
    return this.cache;
  }

  get(path: string): string | undefined {
    return this.env[secretEnvName(path)] || this.load()[path] || undefined;
  }

  set(path: string, value: string): void {
    const all = { ...this.load(), [path]: value };
    writePrivateJson(this.path, all);
    ensurePrivateMode(this.path);
    this.mtime = -1;
  }

  delete(path: string): boolean {
    const all = { ...this.load() };
    if (!(path in all)) return false;
    delete all[path];
    writePrivateJson(this.path, all);
    this.mtime = -1;
    return true;
  }

  /** Names only — values are never listed. */
  list(): string[] {
    return Object.keys(this.load()).sort();
  }
}

// ─── Resolution ────────────────────────────────────────────────────────────

const TEMPLATE = /\$\{(cred|secret):([^}]+)\}/g;

function templatesIn(config: ServerConfig): Array<{ kind: "cred" | "secret"; key: string }> {
  const out: Array<{ kind: "cred" | "secret"; key: string }> = [];
  for (const group of [config.auth?.env, config.auth?.headers]) {
    for (const v of Object.values(group ?? {})) {
      for (const m of v.matchAll(TEMPLATE)) out.push({ kind: m[1] as "cred" | "secret", key: m[2] });
    }
  }
  return out;
}

export interface ResolvedForServer {
  runtime: RuntimeCredentials | undefined;
  /** Every secret value substituted — used to redact outputs. */
  secretValues: string[];
}

export class CredentialResolver {
  constructor(private readonly secrets: SecretStore) {}

  /** Whether the server uses the credential system at all. */
  usesCredentials(config: ServerConfig): boolean {
    return Boolean(config.auth?.env || config.auth?.headers);
  }

  /**
   * What's missing for `server` — header names for user credentials, secret names for server ones.
   * Empty when everything resolves.
   */
  missing(server: string, config: ServerConfig, user: UserCredentials): string[] {
    const scope = config.auth?.scope ?? "server";
    // Server-scope credentials are never overridable by what a user sends.
    const userFields = scope === "user" ? user.get(server) ?? {} : {};
    const out: string[] = [];
    for (const t of templatesIn(config)) {
      if (t.kind === "secret") {
        if (this.secrets.get(t.key) === undefined) out.push(`secret "${t.key}" (${secretEnvName(t.key)} or secrets.json)`);
      } else if (userFields[t.key.toLowerCase()] === undefined) {
        // Server scope (or an explicit fallback) takes the credential from the secret `<server>/<field>`.
        const fromSecret = scope === "server" || config.auth?.fallback === "server";
        if (fromSecret && this.secrets.get(`${server}/${t.key}`) !== undefined) continue;
        out.push(scope === "user" ? credHeaderName(server, t.key) : `secret "${server}/${t.key}"`);
      }
    }
    return [...new Set(out)];
  }

  /** Build the runtime env/headers for a server, or throw MissingCredentialError. */
  resolve(server: string, config: ServerConfig, user: UserCredentials): ResolvedForServer {
    if (!this.usesCredentials(config)) return { runtime: undefined, secretValues: [] };

    const missing = this.missing(server, config, user);
    if (missing.length) throw new MissingCredentialError(server, missing);

    const userFields = (config.auth?.scope ?? "server") === "user" ? user.get(server) ?? {} : {};
    const used: string[] = [];
    const expand = (template: string): string =>
      template.replace(TEMPLATE, (_, kind: string, key: string) => {
        const value =
          kind === "secret"
            ? this.secrets.get(key)
            : userFields[key.toLowerCase()] ?? this.secrets.get(`${server}/${key}`);
        used.push(value as string);
        return value as string;
      });

    const expandAll = (group?: Record<string, string>) =>
      group ? Object.fromEntries(Object.entries(group).map(([k, v]) => [k, expand(v)])) : undefined;

    return {
      runtime: { env: expandAll(config.auth?.env), headers: expandAll(config.auth?.headers) },
      secretValues: used,
    };
  }
}

/** A server is visible when it has no `groups`, or the caller is in one of them. */
export function canAccess(config: ServerConfig, user: CallerIdentity): boolean {
  if (!config.groups || config.groups.length === 0) return true;
  return config.groups.some((g) => user.groups.includes(g));
}
