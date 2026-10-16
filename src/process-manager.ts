// src/process-manager.ts
// Manages lifecycle of child MCP server processes (stdio) and HTTP MCP servers

import { createHash } from "crypto";
import { spawn, ChildProcess } from "child_process";
import { ServerConfig, OAuthConfig } from "./router.js";
import { getAccessToken } from "./oauth.js";
import { VERSION, LOG_PREFIX } from "./version.js";
import { buildChildEnv } from "./child-env.js";

/** Streamable HTTP MCP clients must advertise both JSON and SSE. */
const MCP_HTTP_ACCEPT = "application/json, text/event-stream";
/** Protocol revision we offer; servers answer with the revision they support. */
const PROTOCOL_VERSION = "2025-06-18";

/** Default per-call timeout for tools/call (override with `toolTimeoutMs`). */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
/** Sandbox wrappers may `docker build` on first launch before speaking MCP. */
const STDIO_HANDSHAKE_TIMEOUT_MS = 600_000;
const HTTP_HANDSHAKE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverName: string,
    body: string
  ) {
    super(`HTTP ${status} from ${serverName}: ${body}`);
    this.name = "HttpStatusError";
  }
}

/** JSON-RPC error returned by a server; keeps `code` and `data`. */
export class McpRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

function toRpcError(e: { message?: string; code?: number; data?: unknown } | undefined): McpRpcError {
  return new McpRpcError(e?.message ?? "Unknown JSON-RPC error", e?.code, e?.data);
}

type JsonObject = Record<string, unknown>;

function parseSseBlock(block: string): unknown | undefined {
  const dataLines = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined; // ignore non-JSON data
  }
}

function isResponseFor(msg: unknown, id: number | string | undefined): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as JsonObject;
  return !("method" in m) && id !== undefined && m.id === id;
}

async function readSseStream(res: Response, expectedId: number | string): Promise<unknown> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fallback: unknown;

  const consider = (block: string): unknown | undefined => {
    const msg = parseSseBlock(block);
    if (msg === undefined) return undefined;
    if (isResponseFor(msg, expectedId)) return msg;
    if (!(msg as JsonObject).method) fallback = msg;
    return undefined;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const hit = consider(block);
      if (hit !== undefined) {
        await reader.cancel().catch(() => undefined);
        return hit;
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const hit = consider(buffer);
    if (hit !== undefined) return hit;
  }
  return fallback ?? {};
}

/**
 * Parse application/json or text/event-stream MCP responses into a JSON-RPC object.
 * For SSE, the message whose `id` equals `expectedId` wins (streams are read
 * incrementally and closed as soon as it arrives); otherwise the last
 * non-request message is used.
 */
export async function readMcpHttpResponse(
  res: Response,
  expectedId?: number | string
): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";

  if (
    ct.includes("text/event-stream") &&
    expectedId !== undefined &&
    res.body &&
    typeof res.body.getReader === "function"
  ) {
    return readSseStream(res, expectedId);
  }

  const text = await res.text();
  if (!text) return {};

  if (ct.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    let fallback: unknown;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const msg = parseSseBlock(block);
      if (msg === undefined) continue;
      if (isResponseFor(msg, expectedId)) return msg;
      if (!(msg as JsonObject).method) fallback = msg;
    }
    if (fallback !== undefined) return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON MCP HTTP response (${ct || "unknown content-type"})`);
  }
}

export interface ActiveServer {
  name: string;
  process: ChildProcess;
  tools: MCPTool[];
  activatedAt: Date;
  /** Stable hash of stdio spawn inputs; if config changes, ProcessManager respawns. */
  spawnSig: string;
  toolTimeoutMs: number;
}

export interface ActiveHttpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  tools: MCPTool[];
  activatedAt: Date;
  nextId: number;
  config: ServerConfig; // kept for token refresh on 401
  /** Resolved OAuth overrides (may be empty when fully auto-discovered). */
  oauth?: OAuthConfig;
  /** True when the user supplied an Authorization header; we never replace it. */
  staticAuth: boolean;
  /** Hash of the URL/headers/credentials this session was opened with. */
  sig: string;
  toolTimeoutMs: number;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string; // track which server owns this tool
}

export interface ProcessManagerOptions {
  /** Called whenever the set of exposed tools changes (activate, deactivate, exit, refresh). */
  onToolsChanged?: () => void;
  /** Tool names that servers may not expose (e.g. the broker's own meta-tools). */
  reservedToolNames?: Iterable<string>;
  /** Called with a server's full tool list after activation and after every refresh. */
  onServerTools?: (serverName: string, tools: MCPTool[]) => void;
  /**
   * Gateway mode: the user this manager serves. OAuth tokens of servers with
   * `auth.scope: "user"` are stored per owner instead of per server.
   */
  owner?: string;
}

/**
 * Credentials resolved at runtime by the gateway (never read from servers.json).
 * Merged after `${VAR}` expansion and never re-expanded, so a credential value that happens
 * to contain `${…}` cannot pull in the gateway's own environment.
 */
export interface RuntimeCredentials {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

function hashOf(values: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower && headers[k]);
}

export class ProcessManager {
  private active = new Map<string, ActiveServer>();
  private activeHttp = new Map<string, ActiveHttpServer>();
  /** In-flight activations, so concurrent callers share one spawn / OAuth flow. */
  private activating = new Map<string, Promise<MCPTool[]>>();
  // Keyed by child process so IDs are scoped per-child and never collide
  private pendingRequests = new Map<ChildProcess, Map<number, {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
  }>>();
  // Per-child stdout buffers — avoids a new listener per sendRequest call
  private stdoutBuffers = new Map<ChildProcess, string>();
  // Per-child monotonic request counter
  private requestIds = new Map<ChildProcess, number>();

  private readonly onToolsChanged?: () => void;
  private readonly onServerTools?: (serverName: string, tools: MCPTool[]) => void;
  private readonly reserved: Set<string>;
  private readonly owner?: string;

  constructor(opts: ProcessManagerOptions = {}) {
    this.owner = opts.owner;
    this.onToolsChanged = opts.onToolsChanged;
    this.onServerTools = opts.onServerTools;
    this.reserved = new Set(opts.reservedToolNames ?? []);
  }

  private emitChanged(): void {
    try {
      this.onToolsChanged?.();
    } catch {
      /* listeners must never break lifecycle handling */
    }
  }

  private reportTools(name: string, tools: MCPTool[]): void {
    try {
      this.onServerTools?.(name, tools);
    } catch {
      /* indexing must never break lifecycle handling */
    }
  }

  /** Inputs that determine the stdio child process; any change requires a new spawn. */
  private stdioSpawnSignature(config: ServerConfig, runtime?: RuntimeCredentials): string {
    return JSON.stringify({
      command: config.command ?? null,
      args: config.args ?? [],
      env: config.env ?? {},
      inheritEnv: config.inheritEnv ?? null,
      // A changed credential means a fresh process (hashed so secrets never sit in a map key).
      runtimeEnv: runtime?.env ? hashOf(runtime.env) : null,
    });
  }

  /** Same for HTTP servers: a changed URL, header or credential means a fresh session. */
  private httpSignature(config: ServerConfig, runtime?: RuntimeCredentials): string {
    return JSON.stringify({
      url: config.url ?? null,
      headers: config.headers ?? {},
      runtimeHeaders: runtime?.headers ? hashOf(runtime.headers) : null,
    });
  }

  activate(name: string, config: ServerConfig, runtime?: RuntimeCredentials): Promise<MCPTool[]> {
    const inFlight = this.activating.get(name);
    if (inFlight) return inFlight;

    const p = this.doActivate(name, config, runtime).finally(() => {
      this.activating.delete(name);
    });
    this.activating.set(name, p);
    return p;
  }

  private async doActivate(
    name: string,
    config: ServerConfig,
    runtime?: RuntimeCredentials
  ): Promise<MCPTool[]> {
    if (config.type === "http" || config.url) {
      const existing = this.activeHttp.get(name);
      const httpSig = this.httpSignature(config, runtime);
      if (existing) {
        if (existing.sig === httpSig) return existing.tools;
        this.deactivate(name);
      }
      return this.activateHttp(name, config, runtime, httpSig);
    }

    const sig = this.stdioSpawnSignature(config, runtime);
    const existingStdio = this.active.get(name);
    if (existingStdio) {
      if (existingStdio.spawnSig === sig) return existingStdio.tools;
      this.deactivate(name);
    }
    if (this.activeHttp.has(name)) return this.activeHttp.get(name)!.tools;

    if (!config.command) {
      throw new Error(`Server "${name}" has no command or url configured`);
    }

    console.error(`${LOG_PREFIX} Activating server: ${name}`);

    const env = { ...this.resolveEnv(config.env ?? {}, name), ...(runtime?.env ?? {}) };
    const child = spawn(config.command, config.args ?? [], {
      env: buildChildEnv(process.env, config.inheritEnv, env),
    }) as ChildProcess;

    this.stdoutBuffers.set(child, "");
    this.pendingRequests.set(child, new Map());
    this.requestIds.set(child, 1);

    // Without these listeners a bad command (ENOENT) or a dead pipe (EPIPE)
    // would be an unhandled 'error' event and take down the whole broker.
    child.on("error", (err) => {
      this.rejectPending(child, new Error(`[${name}] failed to run "${config.command}": ${err.message}`));
    });
    child.stdin?.on("error", (err) => {
      this.rejectPending(child, new Error(`[${name}] stdin error: ${err.message}`));
    });

    child.stderr?.on("data", (data) => {
      console.error(`[${name}] ${data.toString().trim()}`);
    });

    child.stdout?.on("data", (chunk) => {
      const buf = (this.stdoutBuffers.get(child) ?? "") + chunk.toString();
      const lines = buf.split("\n");
      this.stdoutBuffers.set(child, lines.pop() ?? "");

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: JsonObject;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON line
        }
        this.handleChildMessage(name, child, msg);
      }
    });

    // Reject all pending requests if the child exits unexpectedly
    child.on("exit", (code) => {
      this.rejectPending(child, new Error(`[${name}] process exited with code ${code}`));
      // Remove from active map if it died on its own
      if (this.active.get(name)?.process === child) {
        this.active.delete(name);
        this.forgetChild(child);
        console.error(`${LOG_PREFIX} ${name} exited (code ${code})`);
        this.emitChanged();
      }
    });

    let tools: MCPTool[];
    try {
      await this.handshake(child, { timeoutMs: STDIO_HANDSHAKE_TIMEOUT_MS });
      tools = await this.listToolsStdio(child, name, STDIO_HANDSHAKE_TIMEOUT_MS);
      this.assertNoToolCollisions(name, tools);
    } catch (err) {
      // Never leak a half-initialised child.
      this.disposeChild(child, err as Error);
      throw err;
    }

    this.active.set(name, {
      name,
      process: child,
      tools,
      activatedAt: new Date(),
      spawnSig: sig,
      toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    });

    console.error(`${LOG_PREFIX} ${name} activated with ${tools.length} tools`);
    this.reportTools(name, tools);
    this.emitChanged();
    return tools;
  }

  // ── stdio message handling ───────────────────────────────────────────────

  private handleChildMessage(name: string, child: ChildProcess, msg: JsonObject): void {
    // Anything with a `method` is server → client traffic, never a response —
    // even if its id happens to collide with one of our pending request ids.
    if (typeof msg.method === "string") {
      const hasId = msg.id !== undefined && msg.id !== null;
      if (hasId) {
        const reply = msg.method === "ping"
          ? { jsonrpc: "2.0", id: msg.id, result: {} }
          : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
        this.writeLine(child, reply);
      } else if (msg.method === "notifications/tools/list_changed") {
        void this.refreshStdioTools(name, child);
      }
      return;
    }

    const id = msg.id as number;
    const pending = this.pendingRequests.get(child)?.get(id);
    if (!pending) return;
    this.pendingRequests.get(child)!.delete(id);
    if (msg.error) {
      pending.reject(toRpcError(msg.error as { message?: string; code?: number; data?: unknown }));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async refreshStdioTools(name: string, child: ChildProcess): Promise<void> {
    if (this.active.get(name)?.process !== child) return;
    try {
      const tools = await this.listToolsStdio(child, name, DEFAULT_REQUEST_TIMEOUT_MS * 3);
      const current = this.active.get(name);
      if (current && current.process === child) {
        current.tools = tools;
        this.reportTools(name, tools);
        this.emitChanged();
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${name}: tools/list refresh failed: ${(err as Error).message}`);
    }
  }

  private writeLine(child: ChildProcess, payload: unknown): void {
    try {
      child.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      /* the 'error' listener on stdin handles dead pipes */
    }
  }

  private rejectPending(child: ChildProcess, err: Error): void {
    const pending = this.pendingRequests.get(child);
    if (!pending || pending.size === 0) return;
    for (const { reject } of Array.from(pending.values())) reject(err);
    pending.clear();
  }

  private forgetChild(child: ChildProcess): void {
    this.stdoutBuffers.delete(child);
    this.pendingRequests.delete(child);
    this.requestIds.delete(child);
  }

  /** Reject outstanding requests, drop bookkeeping, and kill the process. */
  private disposeChild(child: ChildProcess, reason: Error): void {
    this.rejectPending(child, reason);
    this.forgetChild(child);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private assertNoToolCollisions(name: string, tools: MCPTool[]): void {
    const owners = new Map<string, string>();
    for (const [other, s] of this.active) {
      if (other !== name) for (const t of s.tools) owners.set(t.name, other);
    }
    for (const [other, s] of this.activeHttp) {
      if (other !== name) for (const t of s.tools) owners.set(t.name, other);
    }

    const clashes: string[] = [];
    for (const t of tools) {
      if (this.reserved.has(t.name)) clashes.push(`${t.name} (reserved broker tool)`);
      else if (owners.has(t.name)) clashes.push(`${t.name} (provided by "${owners.get(t.name)}")`);
    }
    if (clashes.length > 0) {
      throw new Error(
        `Cannot activate "${name}": tool name collision — ${clashes.join(", ")}. ` +
          `Deactivate the other server first.`
      );
    }
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private normalizeOAuthConfig(oauth: ServerConfig["oauth"]): OAuthConfig | undefined {
    if (oauth === undefined || oauth === false) return undefined;
    if (oauth === true) return {};
    return oauth;
  }

  private async attachOAuth(
    name: string,
    url: string,
    headers: Record<string, string>,
    oauth: OAuthConfig | undefined,
    force: boolean,
    config: ServerConfig
  ): Promise<OAuthConfig> {
    const resolved = oauth ?? {};
    const owner = config.auth?.scope === "user" ? this.owner : undefined;
    const token = await getAccessToken(name, url, resolved, { force, owner });
    headers["Authorization"] = `Bearer ${token}`;
    return resolved;
  }

  private async activateHttp(
    name: string,
    config: ServerConfig,
    runtime: RuntimeCredentials | undefined,
    sig: string
  ): Promise<MCPTool[]> {
    const url = config.url!;
    const resolvedEnv = this.resolveEnv(config.env ?? {}, name);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: MCP_HTTP_ACCEPT,
    };

    // Resolve ${VAR} in explicit headers
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      headers[k] = this.expandVars(v, name, resolvedEnv);
    }
    // Gateway credentials go in last and are never re-expanded.
    Object.assign(headers, runtime?.headers ?? {});

    const staticAuth = hasHeader(headers, "authorization");
    const oauthAllowed = config.oauth !== false && !staticAuth;
    let oauth = this.normalizeOAuthConfig(config.oauth);

    // Explicit `oauth` config → authenticate up front. Otherwise only on a 401.
    if (oauthAllowed && oauth !== undefined) {
      oauth = await this.attachOAuth(name, url, headers, oauth, false, config);
    }

    let tools: MCPTool[];
    try {
      tools = await this.fetchToolsHttp(url, headers, name);
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 401 && oauthAllowed) {
        console.error(`${LOG_PREFIX} ${name} returned 401 on activate — starting OAuth`);
        oauth = await this.attachOAuth(name, url, headers, oauth, true, config);
        tools = await this.fetchToolsHttp(url, headers, name);
      } else {
        throw err;
      }
    }

    this.assertNoToolCollisions(name, tools);

    this.activeHttp.set(name, {
      name,
      url,
      headers,
      tools,
      config,
      oauth,
      staticAuth,
      sig,
      activatedAt: new Date(),
      nextId: 1,
      toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    });

    console.error(`${LOG_PREFIX} ${name} (http) activated with ${tools.length} tools`);
    this.reportTools(name, tools);
    this.emitChanged();
    return tools;
  }

  private async httpFetch(
    serverName: string,
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`HTTP request to ${serverName} timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[] }> {
    const httpServer = this.activeHttp.get(serverName);
    if (httpServer) {
      return this.callToolHttp(httpServer, toolName, args);
    }

    const server = this.active.get(serverName);
    if (!server) throw new Error(`Server ${serverName} is not active`);

    const child = server.process;
    const id = this.nextId(child);
    return this.sendRequest(
      child,
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      },
      server.toolTimeoutMs
    ) as Promise<{ content: unknown[] }>;
  }

  private async callToolHttp(
    server: ActiveHttpServer,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[] }> {
    const id = server.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    const send = () =>
      this.httpFetch(
        server.name,
        server.url,
        { method: "POST", headers: server.headers, body },
        server.toolTimeoutMs
      );

    let res = await send();

    // 401: force a fresh token (never replay the rejected one), retry once.
    // A user-supplied static Authorization header is never replaced.
    if (res.status === 401 && server.config.oauth !== false && !server.staticAuth) {
      console.error(`${LOG_PREFIX} ${server.name} returned 401 — refreshing OAuth token`);
      server.oauth = await this.attachOAuth(
        server.name,
        server.url,
        server.headers,
        server.oauth ?? this.normalizeOAuthConfig(server.config.oauth),
        true,
        server.config
      );
      res = await send();
    }

    // 404 with a session id means the session expired: re-initialize, retry once.
    if (res.status === 404 && server.headers["mcp-session-id"]) {
      console.error(`${LOG_PREFIX} ${server.name} session expired — re-initializing`);
      server.tools = await this.fetchToolsHttp(server.url, server.headers, server.name);
      res = await send();
    }

    if (!res.ok) {
      throw new HttpStatusError(res.status, server.name, await res.text());
    }

    const data = (await readMcpHttpResponse(res, id)) as {
      result?: { content: unknown[] };
      error?: { message: string; code?: number; data?: unknown };
    };
    if (data.error) throw toRpcError(data.error);
    return data.result ?? { content: [] };
  }

  deactivate(name: string): boolean {
    const http = this.activeHttp.get(name);
    if (http) {
      this.activeHttp.delete(name);
      const sessionId = http.headers["mcp-session-id"];
      if (sessionId) {
        // Best-effort session termination (spec: DELETE with the session id).
        void Promise.resolve()
          .then(() => fetch(http.url, { method: "DELETE", headers: { ...http.headers }, signal: AbortSignal.timeout(5000) }))
          .catch(() => undefined);
      }
      console.error(`${LOG_PREFIX} Deactivated server: ${name}`);
      this.emitChanged();
      return true;
    }

    const server = this.active.get(name);
    if (!server) return false;

    // Remove first so the child's 'exit' handler doesn't treat this as a crash.
    this.active.delete(name);
    this.disposeChild(server.process, new Error(`Server "${name}" was deactivated`));
    console.error(`${LOG_PREFIX} Deactivated server: ${name}`);
    this.emitChanged();
    return true;
  }

  listActive(): string[] {
    return [
      ...Array.from(this.active.keys()),
      ...Array.from(this.activeHttp.keys()),
    ];
  }

  getAllActiveTools(): MCPTool[] {
    return [
      ...Array.from(this.active.values()).flatMap(s => s.tools),
      ...Array.from(this.activeHttp.values()).flatMap(s => s.tools),
    ];
  }

  findServerForTool(toolName: string): string | undefined {
    for (const [name, server] of this.active.entries()) {
      if (server.tools.some(t => t.name === toolName)) return name;
    }
    for (const [name, server] of this.activeHttp.entries()) {
      if (server.tools.some(t => t.name === toolName)) return name;
    }
    return undefined;
  }

  private nextId(child: ChildProcess): number {
    const id = this.requestIds.get(child) ?? 1;
    this.requestIds.set(child, id + 1);
    return id;
  }

  /** Replace ${VAR} from the process env (or the server's own env), warning on gaps. */
  private expandVars(
    value: string,
    serverName: string,
    fallback: Record<string, string> = {}
  ): string {
    return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
      const v = process.env[varName] ?? fallback[varName];
      if (v === undefined) {
        console.error(
          `${LOG_PREFIX} warning: ${serverName} references \${${varName}} but it is not set in the environment`
        );
        return "";
      }
      return v;
    });
  }

  private resolveEnv(env: Record<string, string>, serverName: string): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      resolved[k] = this.expandVars(v, serverName);
    }
    return resolved;
  }

  private async fetchToolsHttp(
    url: string,
    headers: Record<string, string>,
    serverName: string
  ): Promise<MCPTool[]> {
    // Fresh handshake → drop any previous session / negotiated version.
    delete headers["mcp-session-id"];
    delete headers["MCP-Protocol-Version"];

    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lazygate", version: VERSION },
      },
    });

    const post = (body: string) =>
      this.httpFetch(serverName, url, { method: "POST", headers, body }, HTTP_HANDSHAKE_TIMEOUT_MS);

    const initRes = await post(initBody);
    if (!initRes.ok) {
      throw new HttpStatusError(initRes.status, serverName, await initRes.text());
    }

    // Persist session ID for all subsequent requests (required by some servers e.g. Datadog)
    const sessionId = initRes.headers?.get("mcp-session-id");
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const initMsg = (await readMcpHttpResponse(initRes, 1).catch(() => undefined)) as
      | { result?: { protocolVersion?: string }; error?: { message: string; code?: number; data?: unknown } }
      | undefined;
    if (initMsg?.error) throw toRpcError(initMsg.error);

    // Required on every request after initialize (spec 2025-06-18+).
    headers["MCP-Protocol-Version"] = initMsg?.result?.protocolVersion ?? PROTOCOL_VERSION;

    // Send initialized notification (some servers won't respond to tools/list without it)
    const notifBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    try {
      const notifRes = await post(notifBody);
      await notifRes?.body?.cancel?.().catch?.(() => undefined);
    } catch {
      /* best-effort */
    }

    type ToolsListResult = {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      nextCursor?: string;
    };

    const allTools: ToolsListResult["tools"] = [];
    let cursor: string | undefined;
    let reqId = 2;

    do {
      const id = reqId++;
      const listRes = await post(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: cursor ? { cursor } : {},
        })
      );
      if (!listRes.ok) {
        throw new HttpStatusError(listRes.status, serverName, await listRes.text());
      }

      const data = (await readMcpHttpResponse(listRes, id)) as {
        result?: ToolsListResult;
        error?: { message: string; code?: number; data?: unknown };
      };
      if (data.error) throw toRpcError(data.error);

      allTools.push(...(data.result?.tools ?? []));
      cursor = data.result?.nextCursor;
    } while (cursor);

    return allTools.map((t) => ({ ...t, serverName }));
  }

  private async handshake(child: ChildProcess, opts: { timeoutMs: number }): Promise<void> {
    await this.sendRequest(
      child,
      {
        jsonrpc: "2.0",
        id: this.nextId(child),
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "lazygate", version: VERSION },
        },
      },
      opts.timeoutMs
    );

    // Required notification — some servers won't respond to tools/list without it
    this.writeLine(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  }

  /** tools/list, following nextCursor for paginated servers. */
  private async listToolsStdio(
    child: ChildProcess,
    serverName: string,
    timeoutMs: number
  ): Promise<MCPTool[]> {
    type ToolsListResult = {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      nextCursor?: string;
    };

    const allTools: ToolsListResult["tools"] = [];
    let cursor: string | undefined;

    do {
      const result = (await this.sendRequest(
        child,
        {
          jsonrpc: "2.0",
          id: this.nextId(child),
          method: "tools/list",
          params: cursor ? { cursor } : {},
        },
        timeoutMs
      )) as ToolsListResult;

      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools.map((t) => ({ ...t, serverName }));
  }

  private sendRequest(
    child: ChildProcess,
    request: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = request.id as number;
      const childPending = this.pendingRequests.get(child);
      if (!childPending) {
        reject(new Error(`No pending map for child process (already deactivated?)`));
        return;
      }

      const timer = setTimeout(() => {
        if (childPending.delete(id)) {
          reject(new Error(`Request ${id} (${String(request.method)}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();

      childPending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.writeLine(child, request);
    });
  }
}
