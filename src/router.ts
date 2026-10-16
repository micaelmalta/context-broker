// src/router.ts
// Scores and selects relevant servers based on a query

import { readFileSync } from "fs";
import type { OAuthConfig } from "./oauth.js";
import { parseServersConfig, reportConfigErrors } from "./config.js";
import { scoreEntry } from "./scoring.js";
import { ToolIndex, toolText } from "./tool-index.js";
import { LOG_PREFIX } from "./version.js";

export type { OAuthConfig };

/**
 * Where a server's credentials come from (gateway mode; ignored by plain stdio mode unless
 * `${secret:…}` / `${cred:…}` templates are used).
 * - scope "server" (default): one credential for everyone — `${secret:path}` from the gateway's
 *   secret store.
 * - scope "user": each user's own — `${cred:field}` from the `X-Lazygate-Cred-<Server>-<Field>`
 *   request headers, and per-user OAuth tokens for HTTP servers.
 * - fallback "server": when the user sent nothing, `${cred:field}` falls back to the secret
 *   `<server>/<field>`.
 * `env` (stdio) and `headers` (HTTP) are templates applied on top of the server's own.
 */
export interface AuthConfig {
  scope?: "user" | "server";
  fallback?: "server";
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ServerConfig {
  description: string;
  keywords: string[];
  // stdio transport (default)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport
  type?: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  /**
   * OAuth for HTTP MCP servers.
   * - omit / undefined: start OAuth only if the server answers 401
   * - true: force OAuth (discover clientId + callback port)
   * - false: never attempt OAuth
   * - object: optional overrides (clientId, callbackPort, scopes); missing fields are discovered
   */
  oauth?: boolean | OAuthConfig;
  autoActivate: boolean;
  /**
   * Environment passed to a stdio child.
   * - omit / true: the broker's whole environment (default)
   * - false: only a minimal base set (PATH, HOME, locale, temp dirs, proxies, …)
   * - string[]: the base set plus the listed variable names (`PREFIX_*` allowed)
   * The server's own `env` entries are always added on top.
   */
  inheritEnv?: boolean | string[];
  /** Credential sources (see AuthConfig). */
  auth?: AuthConfig;
  /** Gateway mode: only users in one of these groups can see or use the server (omit = everyone). */
  groups?: string[];
  /** Per-call timeout for tools/call (default 5 minutes). */
  toolTimeoutMs?: number;
  /** Set by `migrate` so `revert` can find the entries it created. */
  migratedFrom?: string;
  /** Plugin keys that `migrate` disabled for this server (re-enabled by `revert`). */
  disabledPlugins?: string[];
}

export interface RouterResult {
  name: string;
  score: number;
  /** Keywords that matched. */
  reason: string[];
  /** Description words that matched. */
  descriptionMatches: string[];
  /** Words from the server's (learned) tool names/descriptions that matched. */
  toolMatches: string[];
}

export class ToolRouter {
  private servers: Record<string, ServerConfig>;
  private readonly configPath?: string;

  private readonly toolIndex?: ToolIndex;

  constructor(servers: Record<string, ServerConfig>, configPath?: string, toolIndex?: ToolIndex) {
    this.servers = servers;
    this.configPath = configPath;
    this.toolIndex = toolIndex;
  }

  /**
   * Re-read server definitions from disk (same path as at startup).
   * Picks up edits to servers.json without restarting the broker process.
   * On any read/parse/validation failure the previous definitions are kept.
   * Returns true when the registry was refreshed.
   */
  reloadServersFromDisk(): boolean {
    if (!this.configPath) return false;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf-8"));
      const { entries, errors } = parseServersConfig(raw, this.configPath);
      reportConfigErrors(errors);
      this.servers = entries;
      return true;
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Could not reload ${this.configPath}: ${(err as Error).message} — keeping previous config`
      );
      return false;
    }
  }

  /**
   * Score all servers against a query.
   * Returns ranked list with scores and match reasons.
   */
  rank(query: string): RouterResult[] {
    const results: RouterResult[] = [];

    for (const [name, config] of Object.entries(this.servers)) {
      const learned = this.toolIndex?.get(name, config) ?? [];
      const s = scoreEntry(query, {
        description: config.description,
        keywords: config.keywords,
        toolText: learned.length ? toolText(learned) : undefined,
      });
      if (s.score > 0) {
        results.push({
          name,
          score: s.score,
          reason: s.keywords,
          descriptionMatches: s.descriptionWords,
          toolMatches: s.toolWords,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Select top-k servers for a query.
   */
  select(query: string, topK = 3): string[] {
    return this.rank(query).slice(0, topK).map((r) => r.name);
  }

  getConfig(name: string): ServerConfig | undefined {
    return this.servers[name];
  }

  listAll(): string[] {
    return Object.keys(this.servers);
  }
}
