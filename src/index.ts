#!/usr/bin/env node
// src/index.ts
// MCP Broker - exposes meta-tools to Claude Code,
// lazily activates real MCP servers on demand

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { ToolRouter, ServerConfig } from "./router.js";
import { ProcessManager } from "./process-manager.js";

// ─── Config ────────────────────────────────────────────────────────────────

function resolveConfigPath(): string {
  // --config /path/to/servers.json
  const flagIdx = process.argv.indexOf("--config");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const p = resolve(process.argv[flagIdx + 1]);
    if (!existsSync(p)) throw new Error(`Config file not found: ${p}`);
    return p;
  }

  // ~/.config/mcp-broker/servers.json
  const xdg = resolve(homedir(), ".config", "mcp-broker", "servers.json");
  if (existsSync(xdg)) return xdg;

  // fallback: bundled config (dev / local clone)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const local = resolve(__dirname, "../config/servers.json");
  if (existsSync(local)) return local;

  throw new Error(
    `No config found. Create ~/.config/mcp-broker/servers.json or pass --config <path>.`
  );
}

const configPath = resolveConfigPath();
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const serverConfigs: Record<string, ServerConfig> = config.servers;
console.error(`[mcp-broker] Config: ${configPath}`);

const router = new ToolRouter(serverConfigs);
const manager = new ProcessManager();

// ─── Meta-tools always exposed ─────────────────────────────────────────────

const META_TOOLS: Tool[] = [
  {
    name: "discover_tools",
    description:
      "Find which tool servers are available and relevant for a task. " +
      "Call this first when you need a capability you don't have yet.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Describe what you want to do"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "activate_server",
    description:
      "Load and connect a tool server, making its tools available. " +
      "Call discover_tools first to find the right server name.",
    inputSchema: {
      type: "object",
      properties: {
        server_name: {
          type: "string",
          description: "Name of the server to activate"
        }
      },
      required: ["server_name"]
    }
  },
  {
    name: "deactivate_server",
    description: "Shut down a tool server to free resources.",
    inputSchema: {
      type: "object",
      properties: {
        server_name: {
          type: "string",
          description: "Name of the server to deactivate"
        }
      },
      required: ["server_name"]
    }
  },
  {
    name: "list_active_servers",
    description: "Show which servers are currently active and their tools.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-broker", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } }
);

// List tools: meta-tools + all tools from active servers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const activeTools = manager.getAllActiveTools().map(t => ({
    name: t.name,
    description: `[${t.serverName}] ${t.description}`,
    inputSchema: t.inputSchema
  }));

  return { tools: [...META_TOOLS, ...activeTools] };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── Meta-tool: discover ──────────────────────────────────────────────────
  if (name === "discover_tools") {
    const query = args?.query as string;
    const ranked = router.rank(query);

    if (ranked.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No matching servers found for: "${query}"\n\nAvailable servers:\n` +
            router.listAll().map(n => {
              const cfg = router.getConfig(n)!;
              return `• ${n}: ${cfg.description}`;
            }).join("\n")
        }]
      };
    }

    const active = manager.listActive();
    const lines = ranked.map(r => {
      const cfg = router.getConfig(r.name)!;
      const status = active.includes(r.name) ? "✓ active" : "○ inactive";
      return `${status} | ${r.name} (score: ${r.score})\n  ${cfg.description}\n  Keywords matched: ${r.reason.join(", ")}`;
    });

    return {
      content: [{
        type: "text",
        text: `Servers relevant to "${query}":\n\n${lines.join("\n\n")}\n\n` +
          `Use activate_server to load an inactive server.`
      }]
    };
  }

  // ── Meta-tool: activate ──────────────────────────────────────────────────
  if (name === "activate_server") {
    const serverName = args?.server_name as string;
    const cfg = router.getConfig(serverName);

    if (!cfg) {
      return {
        content: [{
          type: "text",
          text: `Unknown server: "${serverName}". ` +
            `Available: ${router.listAll().join(", ")}`
        }]
      };
    }

    try {
      const tools = await manager.activate(serverName, cfg);
      // Tell Claude Code the tool list changed so it re-fetches and can call them directly
      await server.notification({ method: "notifications/tools/list_changed", params: {} });
      return {
        content: [{
          type: "text",
          text: `✓ Activated "${serverName}" with ${tools.length} tools:\n` +
            tools.map(t => `  • ${t.name}: ${t.description}`).join("\n")
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to activate "${serverName}": ${(err as Error).message}`
        }]
      };
    }
  }

  // ── Meta-tool: deactivate ────────────────────────────────────────────────
  if (name === "deactivate_server") {
    const serverName = args?.server_name as string;
    manager.deactivate(serverName);
    return {
      content: [{ type: "text", text: `Deactivated "${serverName}"` }]
    };
  }

  // ── Meta-tool: list active ───────────────────────────────────────────────
  if (name === "list_active_servers") {
    const active = manager.listActive();
    if (active.length === 0) {
      return {
        content: [{ type: "text", text: "No servers currently active." }]
      };
    }

    const lines = active.map(n => {
      const tools = manager.getAllActiveTools()
        .filter(t => t.serverName === n)
        .map(t => `    • ${t.name}`)
        .join("\n");
      return `${n}:\n${tools}`;
    });

    return {
      content: [{ type: "text", text: lines.join("\n\n") }]
    };
  }

  // ── Proxy to active server ───────────────────────────────────────────────
  const serverName = manager.findServerForTool(name);
  if (!serverName) {
    // Auto-discover and activate if possible
    const candidates = router.select(name, 1);
    if (candidates.length > 0) {
      const cfg = router.getConfig(candidates[0])!;
      await manager.activate(candidates[0], cfg);
      const retryServer = manager.findServerForTool(name);
      if (retryServer) {
        return await manager.callTool(retryServer, name, (args ?? {}) as Record<string, unknown>);
      }
    }

    return {
      content: [{
        type: "text",
        text: `Tool "${name}" not found. Use discover_tools to find and activate the right server.`
      }]
    };
  }

  try {
    return await manager.callTool(serverName, name, (args ?? {}) as Record<string, unknown>);
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `Error calling ${name}: ${(err as Error).message}`
      }]
    };
  }
});

// ─── Auto-activate servers marked autoActivate: true ──────────────────────

for (const [name, cfg] of Object.entries(serverConfigs)) {
  if (cfg.autoActivate) {
    try {
      await manager.activate(name, cfg);
      await server.notification({ method: "notifications/tools/list_changed", params: {} });
    } catch (err) {
      console.error(`[mcp-broker] Failed to auto-activate "${name}": ${(err as Error).message}`);
    }
  }
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown() {
  for (const name of manager.listActive()) {
    manager.deactivate(name);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp-broker] Running on stdio");
