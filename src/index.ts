#!/usr/bin/env node
// src/index.ts
// MCP Broker - exposes meta-tools to Claude Code,
// lazily activates real MCP servers on demand

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { ToolRouter, ServerConfig } from "./router.js";
import { ProcessManager } from "./process-manager.js";
import { SkillRouter } from "./skill-router.js";
import { parseServersConfig, parseSkillsConfig, reportConfigErrors } from "./config.js";
import { createBroker } from "./broker.js";
import { META_TOOL_NAMES } from "./meta-tools.js";
import { ToolIndex } from "./tool-index.js";
import { VERSION, LOG_PREFIX } from "./version.js";

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

/**
 * Resolution: --<flag> <path> → ~/.config/context-broker/<file>.
 * The bundled config/ directory only holds *examples* and is never loaded
 * implicitly (its paths don't exist on real machines).
 */
function resolveConfigPath(flag: string, file: string): string | null {
  const flagIdx = process.argv.indexOf(flag);
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const p = resolve(process.argv[flagIdx + 1]);
    if (!existsSync(p)) throw new Error(`Config file not found: ${p}`);
    return p;
  }

  const xdg = resolve(homedir(), ".config", "context-broker", file);
  return existsSync(xdg) ? xdg : null;
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

const configPath = resolveConfigPath("--config", "servers.json");
let serverConfigs: Record<string, ServerConfig> = {};
if (configPath) {
  const { entries, errors } = parseServersConfig(loadJson(configPath), configPath);
  serverConfigs = entries;
  reportConfigErrors(errors);
  console.error(`${LOG_PREFIX} Config: ${configPath} (${Object.keys(entries).length} servers)`);
} else {
  console.error(
    `${LOG_PREFIX} No servers.json found. Create ~/.config/context-broker/servers.json ` +
      `(see config/servers.json in the repo for an example) or pass --config <path>. ` +
      `Starting with an empty registry.`
  );
}

const toolIndex = new ToolIndex(resolve(homedir(), ".config", "context-broker", "tool-index.json"));
const router = new ToolRouter(serverConfigs, configPath ?? undefined, toolIndex);

// ─── Skills ────────────────────────────────────────────────────────────────

const skillsConfigPath = resolveConfigPath("--skills", "skills.json");
let skillRouter: SkillRouter | null = null;
if (skillsConfigPath) {
  try {
    const { entries, errors } = parseSkillsConfig(loadJson(skillsConfigPath), skillsConfigPath);
    reportConfigErrors(errors);
    skillRouter = new SkillRouter(entries, skillsConfigPath);
    console.error(`${LOG_PREFIX} Skills config: ${skillsConfigPath} (${Object.keys(entries).length} skills)`);
  } catch (err) {
    // A half-written skills.json must not stop the broker; it is re-read lazily.
    console.error(`${LOG_PREFIX} ${(err as Error).message} — will retry on first use`);
    skillRouter = new SkillRouter({}, skillsConfigPath);
  }
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: "context-broker", version: VERSION },
  { capabilities: { tools: { listChanged: true } } }
);

let connected = false;

/** Tell the client the tool list changed so it re-fetches and can call tools directly. */
function notifyToolsChanged(): void {
  if (!connected) return;
  server.sendToolListChanged().catch(() => {
    /* transport closed during shutdown */
  });
}

const manager = new ProcessManager({
  onToolsChanged: notifyToolsChanged,
  reservedToolNames: META_TOOL_NAMES,
  // Learn what each server's tools do, so discover_tools can route by them later.
  onServerTools: (name, tools) => {
    const cfg = router.getConfig(name);
    if (cfg) toolIndex.record(name, cfg, tools);
  },
});

const broker = createBroker({ router, manager, skillRouter });

server.setRequestHandler(ListToolsRequestSchema, async () => broker.listTools());

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return broker.callTool(name, args as Record<string, unknown> | undefined);
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown() {
  connected = false;
  for (const name of manager.listActive()) {
    manager.deactivate(name);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ──────────────────────────────────────────────────────────────────

// Connect first: auto-activation can take minutes (docker build, OAuth) and
// notifications require a live transport.
const transport = new StdioServerTransport();
await server.connect(transport);
connected = true;
console.error(`${LOG_PREFIX} Running on stdio`);

// Auto-activate servers marked autoActivate: true (in the background)
for (const [name, cfg] of Object.entries(serverConfigs)) {
  if (!cfg.autoActivate) continue;
  manager.activate(name, cfg).catch((err) => {
    console.error(`${LOG_PREFIX} Failed to auto-activate "${name}": ${(err as Error).message}`);
  });
}
