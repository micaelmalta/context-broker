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
import { spawnSync } from "child_process";
import { ToolRouter, ServerConfig } from "./router.js";
import { ProcessManager } from "./process-manager.js";
import { SkillRouter, SkillConfig } from "./skill-router.js";

// ─── Subcommand dispatch ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SUBCOMMANDS: Record<string, string> = {
  migrate: resolve(__dirname, "../scripts/migrate.mjs"),
  revert: resolve(__dirname, "../scripts/revert-migration.mjs"),
  benchmark: resolve(__dirname, "../scripts/benchmark.mjs"),
};

const [, , subcommand, ...rest] = process.argv;
if (subcommand && SUBCOMMANDS[subcommand]) {
  const result = spawnSync(
    process.execPath,
    [SUBCOMMANDS[subcommand], ...rest],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}

// ─── Config ────────────────────────────────────────────────────────────────

function resolveConfigPath(): string {
  // --config /path/to/servers.json
  const flagIdx = process.argv.indexOf("--config");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const p = resolve(process.argv[flagIdx + 1]);
    if (!existsSync(p)) throw new Error(`Config file not found: ${p}`);
    return p;
  }

  // ~/.config/context-broker/servers.json
  const xdg = resolve(homedir(), ".config", "context-broker", "servers.json");
  if (existsSync(xdg)) return xdg;

  // fallback: bundled config (dev / local clone)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const local = resolve(__dirname, "../config/servers.json");
  if (existsSync(local)) return local;

  throw new Error(
    `No config found. Create ~/.config/context-broker/servers.json or pass --config <path>.`
  );
}

const configPath = resolveConfigPath();
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const serverConfigs: Record<string, ServerConfig> = config.servers;
console.error(`[context-broker] Config: ${configPath}`);

const router = new ToolRouter(serverConfigs);
const manager = new ProcessManager();

// ─── Skills ────────────────────────────────────────────────────────────────

function resolveSkillsConfigPath(): string | null {
  const flagIdx = process.argv.indexOf("--skills");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const p = resolve(process.argv[flagIdx + 1]);
    if (!existsSync(p)) throw new Error(`Skills config not found: ${p}`);
    return p;
  }

  const xdg = resolve(homedir(), ".config", "context-broker", "skills.json");
  if (existsSync(xdg)) return xdg;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const local = resolve(__dirname, "../config/skills.json");
  if (existsSync(local)) return local;

  return null;
}

const skillsConfigPath = resolveSkillsConfigPath();
const skillRouter = skillsConfigPath
  ? new SkillRouter(
      (JSON.parse(readFileSync(skillsConfigPath, "utf-8")) as { skills: Record<string, SkillConfig> }).skills
    )
  : null;

if (skillsConfigPath) {
  console.error(`[context-broker] Skills config: ${skillsConfigPath}`);
}

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
  },
  {
    name: "discover_skill",
    description:
      "Find the right skill for a task before executing it. " +
      "Call this at the start of any task that produces a file or " +
      "requires specialist knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do" }
      },
      required: ["query"]
    }
  },
  {
    name: "load_skill",
    description: "Load a skill's full instructions into context.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Name returned by discover_skill" }
      },
      required: ["skill_name"]
    }
  }
];

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: "context-broker", version: "1.0.0" },
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

  // ── Meta-tool: discover_skill ────────────────────────────────────────────
  if (name === "discover_skill") {
    if (!skillRouter) {
      return {
        content: [{ type: "text", text: "No skills registry configured." }]
      };
    }

    const query = args?.query as string;
    const ranked = skillRouter.rank(query);

    if (ranked.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No matching skills found for: "${query}"\n\nAvailable skills:\n` +
            skillRouter.listAll().map(n => {
              const cfg = skillRouter.getConfig(n)!;
              return `• ${n}: ${cfg.description}`;
            }).join("\n")
        }]
      };
    }

    const lines = ranked.map(r => {
      const cfg = skillRouter.getConfig(r.name)!;
      return `${r.name} (score: ${r.score})\n  ${cfg.description}\n  Keywords matched: ${r.reason.join(", ")}`;
    });

    return {
      content: [{
        type: "text",
        text: `Skills relevant to "${query}":\n\n${lines.join("\n\n")}\n\n` +
          `Use load_skill to load a skill's full instructions.`
      }]
    };
  }

  // ── Meta-tool: load_skill ────────────────────────────────────────────────
  if (name === "load_skill") {
    if (!skillRouter) {
      return {
        content: [{ type: "text", text: "No skills registry configured." }]
      };
    }

    const skillName = args?.skill_name as string;
    try {
      const content = skillRouter.load(skillName);
      return {
        content: [{
          type: "text",
          text: `# Skill: ${skillName}\n\n${content}`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: (err as Error).message }]
      };
    }
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
      console.error(`[context-broker] Failed to auto-activate "${name}": ${(err as Error).message}`);
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
console.error("[context-broker] Running on stdio");
