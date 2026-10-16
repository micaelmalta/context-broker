// src/gateway/ui-api.ts
// Web UI backend: static assets under /ui and a small JSON API under /ui/api.
//
// Auth is the same bearer token as the MCP endpoint, sent in an Authorization header by the page's
// script (no cookies, so no CSRF). Everyone can manage their own stored credentials and see their own
// audit entries; tokens, secrets, sessions and server settings need an admin token.

import type { IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "fs";
import { parseServersConfig } from "../config.js";
import type { ServerConfig } from "../router.js";
import type { Registry } from "../registry.js";
import { CredentialResolver, SecretStore, canAccess, credHeaderName, secretEnvName } from "./credentials.js";
import { TokenStore, bearerToken, parseDuration, type UserIdentity } from "./tokens.js";
import { UserVault } from "./vault.js";
import { AuditLog } from "./audit.js";
import { readBody, sendJson } from "./http-util.js";
import { UI_HTML, UI_JS, UI_CSS } from "./ui-assets.js";

export interface SessionInfo {
  id: string;
  user: string;
  createdAt: number;
  lastSeen: number;
  servers: string[];
}

export interface UiContext {
  registry: Registry;
  tokens: TokenStore;
  secrets: SecretStore;
  vault?: UserVault;
  audit: AuditLog;
  startedAt: number;
  sessions(): SessionInfo[];
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const MAX_UI_BODY = 64 * 1024;
const TEMPLATE_CRED = /\$\{cred:([^}]+)\}/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** `${cred:x}` field names a server asks users for. */
function userFields(cfg: ServerConfig): string[] {
  const out = new Set<string>();
  for (const group of [cfg.auth?.env, cfg.auth?.headers]) {
    for (const v of Object.values(group ?? {})) for (const m of v.matchAll(TEMPLATE_CRED)) out.add(m[1].toLowerCase());
  }
  return [...out];
}

const asObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Expected a JSON object");
  return v as Record<string, unknown>;
};

const asString = (v: unknown, what: string, max = 8192): string => {
  if (typeof v !== "string" || !v.length) throw new HttpError(400, `${what} is required`);
  if (v.length > max) throw new HttpError(400, `${what} is too long`);
  return v;
};

function stringMap(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObject(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) {
    if (typeof val !== "string") throw new HttpError(400, `${what}.${k} must be a string`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export function isUiPath(path: string): boolean {
  return path === "/ui" || path.startsWith("/ui/");
}

export async function handleUi(
  ctx: UiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams
): Promise<void> {
  const headers = SECURITY_HEADERS;

  if (req.method === "GET" || req.method === "HEAD") {
    const asset =
      path === "/ui" || path === "/ui/"
        ? ([UI_HTML, "text/html; charset=utf-8"] as const)
        : path === "/ui/app.js"
          ? ([UI_JS, "text/javascript; charset=utf-8"] as const)
          : path === "/ui/app.css"
            ? ([UI_CSS, "text/css; charset=utf-8"] as const)
            : null;
    if (asset) {
      res.writeHead(200, { "Content-Type": asset[1], ...headers });
      res.end(req.method === "HEAD" ? undefined : asset[0]);
      return;
    }
  }

  if (!path.startsWith("/ui/api/")) return sendJson(res, 404, { error: "not found" }, headers);

  const user = ctx.tokens.verify(bearerToken(req.headers.authorization));
  if (!user) return sendJson(res, 401, { error: "unauthorized" }, { ...headers, "WWW-Authenticate": 'Bearer realm="lazygate"' });

  try {
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req, MAX_UI_BODY).catch((e) => {
      throw new HttpError(400, (e as Error).message);
    });
    const result = await route(ctx, user, req.method ?? "GET", path.slice("/ui/api/".length).split("/").map(decodeURIComponent), query, body);
    if (result === undefined) {
      res.writeHead(204, headers).end();
      return;
    }
    sendJson(res, 200, result, headers);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, headers);
    console.error(`[lazygate] ui request failed: ${(err as Error).message}`);
    sendJson(res, 500, { error: "internal error" }, headers);
  }
}

function requireAdmin(user: UserIdentity): void {
  if (!user.admin) throw new HttpError(403, "This needs an admin token (lazygate token create --admin)");
}

async function route(
  ctx: UiContext,
  user: UserIdentity,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown
): Promise<unknown> {
  const [area, a, b] = seg;
  const { registry } = ctx;

  // ── Anyone with a token ────────────────────────────────────────────────
  if (area === "me" && method === "GET" && seg.length === 1) {
    return { user: user.id, groups: user.groups, admin: user.admin, vault: Boolean(ctx.vault), configPath: user.admin ? registry.configPath : undefined };
  }

  if (area === "connections") return connections(ctx, user, method, seg, body);

  if (area === "audit" && method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(query.get("limit") ?? 100) || 100));
    return { events: ctx.audit.tail(limit, user.admin && query.get("all") === "1" ? undefined : user.id) };
  }

  // ── Admin only ─────────────────────────────────────────────────────────
  requireAdmin(user);

  if (area === "status" && method === "GET") {
    return {
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      sessions: ctx.sessions(),
      servers: registry.router.listAll().length,
      tokens: ctx.tokens.count(),
      secrets: ctx.secrets.list().length,
    };
  }

  if (area === "tokens") {
    if (method === "GET" && seg.length === 1) return { tokens: ctx.tokens.list() };
    if (method === "POST" && seg.length === 1) {
      const o = asObject(body);
      const name = asString(o.user, "user", 64);
      if (!NAME.test(name)) throw new HttpError(400, "user may contain letters, digits, '.', '_' and '-'");
      const groups = Array.isArray(o.groups) ? o.groups.map((g) => String(g).trim()).filter(Boolean) : [];
      let expiresInMs: number | undefined;
      if (typeof o.expires === "string" && o.expires.trim()) {
        try {
          expiresInMs = parseDuration(o.expires);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 100) : undefined;
      return ctx.tokens.create({ user: name, groups, expiresInMs, label, admin: o.admin === true });
    }
    if (method === "DELETE" && a) {
      if (a === user.tokenId) throw new HttpError(409, "You can't revoke the token you're signed in with");
      if (!ctx.tokens.revoke(a)) throw new HttpError(404, "No such token");
      return undefined;
    }
  }

  if (area === "secrets") {
    if (method === "GET" && seg.length === 1) return { secrets: ctx.secrets.list() };
    if (method === "PUT" && seg.length === 1) {
      const o = asObject(body);
      const name = asString(o.path, "path", 200);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) throw new HttpError(400, "Invalid secret path");
      ctx.secrets.set(name, asString(o.value, "value"));
      return { stored: name, env: secretEnvName(name) };
    }
    if (method === "DELETE" && seg.length === 1) {
      const name = asString(query.get("path") ?? "", "path", 200);
      if (!ctx.secrets.delete(name)) throw new HttpError(404, "No such secret");
      return undefined;
    }
  }

  if (area === "servers") {
    if (method === "GET" && seg.length === 1) {
      registry.router.reloadServersFromDisk();
      return {
        editable: Boolean(registry.configPath),
        servers: registry.router.listAll().map((name) => describeServer(name, registry.router.getConfig(name) as ServerConfig)),
      };
    }
    if (method === "PATCH" && a && seg.length === 2) return patchServer(ctx, a, asObject(body));
  }

  throw new HttpError(404, "not found");
}

function describeServer(name: string, c: ServerConfig) {
  return {
    name,
    description: c.description,
    transport: c.url ? "http" : "stdio",
    target: c.url ?? [c.command, ...(c.args ?? [])].join(" "),
    oauth: Boolean(c.oauth),
    autoActivate: Boolean(c.autoActivate),
    groups: c.groups ?? [],
    auth: c.auth
      ? {
          scope: c.auth.scope ?? "server",
          fallback: c.auth.fallback === "server",
          // Templates only (`${cred:…}` / `${secret:…}`) — they hold no values.
          env: c.auth.env ?? {},
          headers: c.auth.headers ?? {},
        }
      : null,
  };
}

/** Write the editable fields of one server back to servers.json (validated, atomic, backed up). */
function patchServer(ctx: UiContext, name: string, patch: Record<string, unknown>): unknown {
  const path = ctx.registry.configPath;
  if (!path) throw new HttpError(409, "No servers.json is loaded (start the gateway with --config or create ~/.config/lazygate/servers.json)");
  let file: { servers?: Record<string, Record<string, unknown>> };
  try {
    file = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new HttpError(500, `Could not read servers.json: ${(e as Error).message}`);
  }
  const entry = file.servers?.[name];
  if (!entry) throw new HttpError(404, "No such server");

  if ("groups" in patch) {
    const g = Array.isArray(patch.groups) ? patch.groups.map((x) => String(x).trim()).filter(Boolean) : [];
    if (g.length) entry.groups = g;
    else delete entry.groups;
  }
  if ("autoActivate" in patch) entry.autoActivate = patch.autoActivate === true;
  if ("auth" in patch) {
    if (patch.auth === null) {
      delete entry.auth;
    } else {
      const a = asObject(patch.auth);
      const scope = a.scope === "user" ? "user" : "server";
      const auth: Record<string, unknown> = { scope };
      if (scope === "user" && a.fallback === true) auth.fallback = "server";
      const env = stringMap(a.env, "auth.env");
      const headers = stringMap(a.headers, "auth.headers");
      if (env) auth.env = env;
      if (headers) auth.headers = headers;
      if (!env && !headers) throw new HttpError(400, "Add at least one env var or header (use ${cred:field} / ${secret:path}), or remove auth");
      entry.auth = auth;
    }
  }

  const checked = parseServersConfig({ servers: { [name]: entry } }, path);
  if (checked.errors.length) throw new HttpError(400, checked.errors.join("; "));

  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(`${path}.bak-ui`, readFileSync(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  ctx.registry.router.reloadServersFromDisk();
  return describeServer(name, ctx.registry.router.getConfig(name) as ServerConfig);
}

// ── Connections (a user's own credentials) ────────────────────────────────

function connections(ctx: UiContext, user: UserIdentity, method: string, seg: string[], body: unknown): unknown {
  const { registry, vault } = ctx;
  if (!vault) throw new HttpError(501, "Credential storage is not enabled on this gateway");
  const resolver = new CredentialResolver(ctx.secrets);

  if (method === "GET" && seg.length === 1) {
    const stored = vault.list(user.id);
    const out = [];
    for (const name of registry.router.listAll()) {
      const cfg = registry.router.getConfig(name) as ServerConfig;
      if (!canAccess(cfg, user) || !resolver.usesCredentials(cfg) || (cfg.auth?.scope ?? "server") !== "user") continue;
      const fields = userFields(cfg);
      if (!fields.length) continue;
      out.push({
        server: name,
        description: cfg.description,
        fields: fields.map((f) => ({
          name: f,
          stored: (stored[name] ?? []).includes(f),
          header: credHeaderName(name, f),
          sharedFallback: cfg.auth?.fallback === "server" && ctx.secrets.get(`${name}/${f}`) !== undefined,
        })),
        oauth: Boolean(cfg.oauth),
      });
    }
    return { connections: out };
  }

  const [, server, field] = seg;
  const cfg = server ? registry.router.getConfig(server) : undefined;
  if (!cfg || !canAccess(cfg, user) || (cfg.auth?.scope ?? "server") !== "user") throw new HttpError(404, "No such server");
  const f = (field ?? "").toLowerCase();
  if (!userFields(cfg).includes(f)) throw new HttpError(404, "That server doesn't take this credential");

  if (method === "PUT" && seg.length === 3) {
    vault.set(user.id, server, f, asString(asObject(body).value, "value"));
    return { stored: true };
  }
  if (method === "DELETE" && seg.length === 3) {
    if (!vault.delete(user.id, server, f)) throw new HttpError(404, "Nothing stored");
    return undefined;
  }
  throw new HttpError(404, "not found");
}
