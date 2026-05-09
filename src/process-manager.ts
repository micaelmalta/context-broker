// src/process-manager.ts
// Manages lifecycle of child MCP server processes (stdio) and HTTP MCP servers

import { spawn, ChildProcess } from "child_process";
import { ServerConfig } from "./router.js";
import { getAccessToken } from "./oauth.js";

export interface ActiveServer {
  name: string;
  process: ChildProcess;
  tools: MCPTool[];
  activatedAt: Date;
}

export interface ActiveHttpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  tools: MCPTool[];
  activatedAt: Date;
  nextId: number;
  config: ServerConfig;  // kept for token refresh on 401
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string; // track which server owns this tool
}

export class ProcessManager {
  private active = new Map<string, ActiveServer>();
  private activeHttp = new Map<string, ActiveHttpServer>();
  // Keyed by child process so IDs are scoped per-child and never collide
  private pendingRequests = new Map<ChildProcess, Map<number, {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
  }>>();
  // Per-child stdout buffers — avoids a new listener per sendRequest call
  private stdoutBuffers = new Map<ChildProcess, string>();
  // Per-child monotonic request counter
  private requestIds = new Map<ChildProcess, number>();

  async activate(name: string, config: ServerConfig): Promise<MCPTool[]> {
    if (this.active.has(name)) return this.active.get(name)!.tools;
    if (this.activeHttp.has(name)) return this.activeHttp.get(name)!.tools;

    console.error(`[router] Activating server: ${name}`);

    if (config.type === "http" || config.url) {
      return this.activateHttp(name, config);
    }

    // Resolve env vars from process environment
    const env = this.resolveEnv(config.env ?? {});

    const child = spawn(config.command!, config.args ?? [], {
      env: { ...process.env, ...env },
    }) as ChildProcess;

    child.stderr?.on("data", (data) => {
      console.error(`[${name}] ${data.toString().trim()}`);
    });

    // Set up a single persistent stdout reader for this child process
    this.stdoutBuffers.set(child, "");
    this.pendingRequests.set(child, new Map());
    this.requestIds.set(child, 1);

    child.stdout?.on("data", (chunk) => {
      const buf = (this.stdoutBuffers.get(child) ?? "") + chunk.toString();
      const lines = buf.split("\n");
      this.stdoutBuffers.set(child, lines.pop() ?? "");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const pending = this.pendingRequests.get(child)?.get(msg.id);
          if (pending) {
            this.pendingRequests.get(child)!.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch {
          // non-JSON line, skip
        }
      }
    });

    // Reject all pending requests if the child exits unexpectedly
    child.on("exit", (code) => {
      const pending = this.pendingRequests.get(child);
      if (pending && pending.size > 0) {
        const err = new Error(`[${name}] process exited with code ${code}`);
        for (const { reject } of pending.values()) reject(err);
        pending.clear();
      }
      // Remove from active map if it died on its own
      if (this.active.get(name)?.process === child) {
        this.active.delete(name);
        this.stdoutBuffers.delete(child);
        this.pendingRequests.delete(child);
        this.requestIds.delete(child);
        console.error(`[router] ${name} exited (code ${code})`);
      }
    });

    // Fetch tools via MCP initialize + tools/list
    // Sandbox wrappers (e.g. run-mcp-sandbox) may run `docker build` on first launch;
    // that can take minutes before the real MCP process speaks JSON on stdout.
    const tools = await this.fetchTools(child, name, { handshakeTimeoutMs: 600_000 });

    this.active.set(name, {
      name,
      process: child,
      tools,
      activatedAt: new Date()
    });

    console.error(`[router] ${name} activated with ${tools.length} tools`);
    return tools;
  }

  private async activateHttp(name: string, config: ServerConfig): Promise<MCPTool[]> {
    const url = config.url!;
    const resolvedEnv = this.resolveEnv(config.env ?? {});
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // Resolve ${VAR} in explicit headers
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      headers[k] = v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? resolvedEnv[n] ?? "");
    }

    // OAuth PKCE flow — fetches/refreshes token automatically
    if (config.oauth) {
      const token = await getAccessToken(name, url, config.oauth);
      headers["Authorization"] = `Bearer ${token}`;
    }

    const tools = await this.fetchToolsHttp(url, headers, name);

    this.activeHttp.set(name, {
      name, url, headers, tools, config,
      activatedAt: new Date(),
      nextId: 1,
    });

    console.error(`[router] ${name} (http) activated with ${tools.length} tools`);
    return tools;
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
    return this.sendRequest(child, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    }) as Promise<{ content: unknown[] }>;
  }

  private async callToolHttp(
    server: ActiveHttpServer,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[] }> {
    const id = server.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0", id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

    let res = await fetch(server.url, { method: "POST", headers: server.headers, body });

    // On 401, attempt token refresh and retry once
    if (res.status === 401 && server.config.oauth) {
      console.error(`[router] ${server.name} returned 401 — refreshing OAuth token`);
      const token = await getAccessToken(server.name, server.url, server.config.oauth);
      server.headers["Authorization"] = `Bearer ${token}`;
      res = await fetch(server.url, { method: "POST", headers: server.headers, body });
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} from ${server.name}: ${await res.text()}`);

    const data = await res.json() as { result?: { content: unknown[] }; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    return data.result ?? { content: [] };
  }

  deactivate(name: string): void {
    if (this.activeHttp.has(name)) {
      this.activeHttp.delete(name);
      console.error(`[router] Deactivated server: ${name}`);
      return;
    }

    const server = this.active.get(name);
    if (server) {
      const child = server.process;
      // Cancel any in-flight requests before killing the process
      const pending = this.pendingRequests.get(child);
      if (pending) {
        const err = new Error(`Server "${name}" was deactivated`);
        for (const { reject } of pending.values()) reject(err);
        pending.clear();
      }
      this.stdoutBuffers.delete(child);
      this.pendingRequests.delete(child);
      this.requestIds.delete(child);
      child.kill();
      this.active.delete(name);
      console.error(`[router] Deactivated server: ${name}`);
    }
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

  private resolveEnv(env: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      // Replace ${VAR} with process.env.VAR
      resolved[k] = v.replace(/\$\{(\w+)\}/g, (_, varName) => {
        return process.env[varName] ?? "";
      });
    }
    return resolved;
  }

  private async fetchToolsHttp(
    url: string,
    headers: Record<string, string>,
    serverName: string
  ): Promise<MCPTool[]> {
    // MCP HTTP: initialize then tools/list
    const initBody = JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "context-broker", version: "1.0.0" },
      },
    });

    const initRes = await fetch(url, { method: "POST", headers, body: initBody });
    if (!initRes.ok) throw new Error(`HTTP ${initRes.status} initializing ${serverName}: ${await initRes.text()}`);

    type ToolsListResult = {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      nextCursor?: string;
    };

    const allTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    let reqId = 2;

    do {
      const listBody = JSON.stringify({
        jsonrpc: "2.0", id: reqId++,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      });

      const listRes = await fetch(url, { method: "POST", headers, body: listBody });
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status} listing tools for ${serverName}`);

      const data = await listRes.json() as { result?: ToolsListResult; error?: { message: string } };
      if (data.error) throw new Error(data.error.message);

      allTools.push(...(data.result?.tools ?? []));
      cursor = data.result?.nextCursor;
    } while (cursor);

    return allTools.map(t => ({ ...t, serverName }));
  }

  private async fetchTools(
    child: ChildProcess,
    serverName: string,
    opts?: { handshakeTimeoutMs?: number }
  ): Promise<MCPTool[]> {
    const t = opts?.handshakeTimeoutMs ?? 10_000;
    // Send MCP initialize handshake
    await this.sendRequest(
      child,
      {
        jsonrpc: "2.0",
        id: this.nextId(child),
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "context-broker", version: "1.0.0" }
        }
      },
      t
    );

    // Required notification — some servers won't respond to tools/list without it
    child.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }) + "\n");

    // Fetch tool list — follow nextCursor for paginated servers
    type ToolsListResult = {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      nextCursor?: string;
    };

    const allTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    let cursor: string | undefined;

    do {
      const result = await this.sendRequest(
        child,
        {
          jsonrpc: "2.0",
          id: this.nextId(child),
          method: "tools/list",
          params: cursor ? { cursor } : {}
        },
        t
      ) as ToolsListResult;

      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools.map(t => ({
      ...t,
      serverName
    }));
  }

  private sendRequest(
    child: ChildProcess,
    request: Record<string, unknown>,
    timeoutMs = 10_000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = request.id as number;
      const childPending = this.pendingRequests.get(child);
      if (!childPending) {
        reject(new Error(`No pending map for child process (already deactivated?)`));
        return;
      }
      childPending.set(id, { resolve, reject });

      setTimeout(() => {
        if (childPending.has(id)) {
          childPending.delete(id);
          reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      child.stdin?.write(JSON.stringify(request) + "\n");
    });
  }
}
