// src/process-manager.ts
// Manages lifecycle of child MCP server processes

import { spawn, ChildProcess } from "child_process";
import { ServerConfig } from "./router.js";

export interface ActiveServer {
  name: string;
  process: ChildProcess;
  tools: MCPTool[];
  activatedAt: Date;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string; // track which server owns this tool
}

export class ProcessManager {
  private active = new Map<string, ActiveServer>();
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
    if (this.active.has(name)) {
      return this.active.get(name)!.tools;
    }

    console.error(`[router] Activating server: ${name}`);

    // Resolve env vars from process environment
    const env = this.resolveEnv(config.env ?? {});

    const child = spawn(config.command, config.args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });

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

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[] }> {
    const server = this.active.get(serverName);
    if (!server) {
      throw new Error(`Server ${serverName} is not active`);
    }

    const child = server.process;
    const id = this.nextId(child);
    return this.sendRequest(child, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    }) as Promise<{ content: unknown[] }>;
  }

  deactivate(name: string): void {
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
    return Array.from(this.active.keys());
  }

  getAllActiveTools(): MCPTool[] {
    return Array.from(this.active.values()).flatMap(s => s.tools);
  }

  findServerForTool(toolName: string): string | undefined {
    for (const [name, server] of this.active.entries()) {
      if (server.tools.some(t => t.name === toolName)) {
        return name;
      }
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
          clientInfo: { name: "mcp-broker", version: "1.0.0" }
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
