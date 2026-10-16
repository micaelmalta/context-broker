// src/gateway/server.ts
// lazygate as an MCP HTTP gateway (Streamable HTTP). One Session per MCP session: its own
// ProcessManager (active servers, child processes, OAuth owner), its own credentials and its own
// tools/list_changed notifications. Sessions are bound to the authenticated user.

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ProcessManager } from "../process-manager.js";
import { createBroker, type BrokerAccess, type ToolResult } from "../broker.js";
import { META_TOOL_NAMES } from "../meta-tools.js";
import type { Registry } from "../registry.js";
import { APP_NAME } from "../paths.js";
import { VERSION, LOG_PREFIX } from "../version.js";
import { CredentialResolver, SecretStore, canAccess, extractUserCreds, type UserCredentials } from "./credentials.js";
import { TokenStore, bearerToken, type UserIdentity } from "./tokens.js";
import { AuditLog } from "./audit.js";
import { Redactor } from "./redact.js";
import { UserVault, mergeCreds } from "./vault.js";
import { readBody, sendJson } from "./http-util.js";
import { handleUi, isUiPath } from "./ui-api.js";

export interface GatewayOptions {
  registry: Registry;
  tokens: TokenStore;
  secrets: SecretStore;
  /** Per-user credentials entered in the web UI (encrypted). Optional. */
  vault?: UserVault;
  audit: AuditLog;
  /** Default 127.0.0.1. Anything else is the caller's responsibility (TLS, firewall). */
  host?: string;
  /** Default 8787; 0 picks a free port. */
  port?: number;
  /** Sessions idle longer than this are closed. Default 30 minutes. */
  idleMs?: number;
  maxSessions?: number;
  maxSessionsPerUser?: number;
  /** Extra Host header values to accept (when behind a proxy or bound to a non-loopback address). */
  allowedHosts?: string[];
}

export interface Gateway {
  url: string;
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

interface Session {
  id: string;
  user: UserIdentity;
  manager: ProcessManager;
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** Credentials from the latest request headers (stored ones are merged in per request). */
  creds: UserCredentials;
  redactor: Redactor;
  createdAt: number;
  lastSeen: number;
  closed: boolean;
}

const rpcError = (status: number, code: number, message: string) => ({
  status,
  body: { jsonrpc: "2.0", error: { code, message }, id: null },
});

const firstText = (r: ToolResult): string => {
  const c = r.content[0] as { text?: unknown } | undefined;
  return typeof c?.text === "string" ? c.text : "";
};

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const { registry, tokens, secrets, audit } = opts;
  const host = opts.host ?? "127.0.0.1";
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const maxSessions = opts.maxSessions ?? 100;
  const maxPerUser = opts.maxSessionsPerUser ?? 10;
  const resolver = new CredentialResolver(secrets);
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  function closeSession(s: Session): void {
    if (s.closed) return;
    s.closed = true;
    if (s.id) sessions.delete(s.id);
    for (const name of s.manager.listActive()) s.manager.deactivate(name);
    void s.server.close().catch(() => undefined);
  }

  function createSession(user: UserIdentity, creds: UserCredentials): Session {
    const redactor = new Redactor();
    const server = new Server({ name: APP_NAME, version: VERSION }, { capabilities: { tools: { listChanged: true } } });

    const session = { user, server, creds, redactor, createdAt: Date.now(), lastSeen: Date.now(), closed: false, id: "" } as Session;

    session.manager = new ProcessManager({
      owner: user.id,
      reservedToolNames: META_TOOL_NAMES,
      onToolsChanged: () => {
        if (!session.closed) server.sendToolListChanged().catch(() => undefined);
      },
      onServerTools: (name, tools) => {
        const cfg = registry.router.getConfig(name);
        if (cfg) registry.toolIndex.record(name, cfg, tools);
      },
    });

    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
      },
    });
    session.transport.onclose = () => closeSession(session);

    const access: BrokerAccess = {
      canUse: (_name, cfg) => canAccess(cfg, user),
      prepare: (name, cfg) => {
        const r = resolver.resolve(name, cfg, session.creds);
        redactor.add(r.secretValues);
        return r.runtime;
      },
      missing: (name, cfg) => resolver.missing(name, cfg, session.creds),
    };

    const broker = createBroker({
      router: registry.router,
      manager: session.manager,
      skillRouter: registry.skillRouter,
      access,
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => broker.listTools());
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const started = Date.now();
      let result: ToolResult;
      try {
        result = await broker.callTool(name, args as Record<string, unknown> | undefined);
      } catch (err) {
        result = { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
      result = redactor.result(result);

      const target =
        name === "activate_server" || name === "deactivate_server"
          ? String((args as { server_name?: unknown } | undefined)?.server_name ?? "")
          : session.manager.findServerForTool(name);
      audit.record({
        user: user.id,
        session: session.id,
        tool: name,
        server: target || undefined,
        ok: !result.isError,
        ms: Date.now() - started,
        error: result.isError ? firstText(result).slice(0, 200) : undefined,
      });
      return result;
    });

    // Auto-activate servers once the client finished initializing; skip anything that still needs credentials.
    server.oninitialized = () => {
      for (const name of registry.router.listAll()) {
        const cfg = registry.router.getConfig(name);
        if (!cfg || !cfg.autoActivate || !canAccess(cfg, user)) continue;
        let runtime;
        try {
          runtime = access.prepare(name, cfg);
        } catch {
          continue;
        }
        session.manager.activate(name, cfg, runtime).catch((err) => {
          console.error(`${LOG_PREFIX} [${user.id}] auto-activate "${name}" failed: ${(err as Error).message}`);
        });
      }
    };

    return session;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  let httpServer: HttpServer;

  /** DNS-rebinding protection: only answer requests addressed to us. */
  function hostAllowed(req: IncomingMessage): boolean {
    const port = (httpServer.address() as AddressInfo).port;
    const allowed = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `${host}:${port}`,
      ...(opts.allowedHosts ?? []),
    ]);
    const hostHeader = req.headers.host;
    if (!hostHeader || !allowed.has(hostHeader)) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (!allowed.has(new URL(origin).host)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path, rawQuery = ""] = (req.url ?? "/").split("?");

    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (path !== "/mcp" && !isUiPath(path)) return sendJson(res, 404, { error: "not found" });

    if (!hostAllowed(req)) return sendJson(res, 403, { error: "host not allowed" });

    if (isUiPath(path)) {
      return handleUi(
        {
          registry,
          tokens,
          secrets,
          vault: opts.vault,
          audit,
          startedAt,
          sessions: () =>
            [...sessions.values()].map((s) => ({
              id: s.id,
              user: s.user.id,
              createdAt: s.createdAt,
              lastSeen: s.lastSeen,
              servers: s.manager.listActive(),
            })),
        },
        req,
        res,
        path,
        new URLSearchParams(rawQuery)
      );
    }

    const user = tokens.verify(bearerToken(req.headers.authorization));
    if (!user) {
      return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="lazygate"' });
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (err) {
        const e = rpcError(400, -32700, (err as Error).message);
        return sendJson(res, e.status, e.body);
      }
    }

    // Stored credentials (web UI) first, then whatever this request sent on top.
    const creds = mergeCreds(opts.vault?.get(user.id) ?? new Map(), extractUserCreds(req.headers, registry.router.listAll()));
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;

    if (sessionId) {
      const session = sessions.get(sessionId);
      // A session id is not a credential: it only works for the user who created it.
      if (!session || session.user.id !== user.id) {
        const e = rpcError(404, -32001, "Session not found");
        return sendJson(res, e.status, e.body);
      }
      session.lastSeen = Date.now();
      session.creds = creds;
      session.redactor.add(Array.from(creds.values()).flatMap((f) => Object.values(f)));
      return session.transport.handleRequest(req, res, body);
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      const mine = [...sessions.values()].filter((s) => s.user.id === user.id).length;
      if (sessions.size >= maxSessions || mine >= maxPerUser) {
        const e = rpcError(503, -32002, "Too many sessions");
        return sendJson(res, e.status, e.body);
      }
      const session = createSession(user, creds);
      session.redactor.add(Array.from(creds.values()).flatMap((f) => Object.values(f)));
      await session.server.connect(session.transport);
      return session.transport.handleRequest(req, res, body);
    }

    const e = rpcError(400, -32000, "Missing Mcp-Session-Id (send an initialize request first)");
    return sendJson(res, e.status, e.body);
  }

  httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`${LOG_PREFIX} request failed: ${(err as Error).message}`);
      const e = rpcError(500, -32603, "Internal error");
      sendJson(res, e.status, e.body);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(opts.port ?? 8787, host, () => resolveListen());
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const s of [...sessions.values()]) {
      if (s.lastSeen < cutoff) {
        console.error(`${LOG_PREFIX} closing idle session for ${s.user.id}`);
        void s.transport.close().catch(() => closeSession(s));
      }
    }
  }, Math.min(60_000, Math.max(1_000, idleMs / 2)));
  sweep.unref();

  const port = (httpServer.address() as AddressInfo).port;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${port}/mcp`,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      for (const s of [...sessions.values()]) closeSession(s);
      await new Promise<void>((r) => {
        httpServer.close(() => r());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
