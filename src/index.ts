#!/usr/bin/env node
// src/index.ts
// lazygate - exposes meta-tools to MCP clients,
// lazily activates real MCP servers on demand.
//   lazygate                      stdio MCP server (default)
//   lazygate serve [--port N]     HTTP gateway (see docs/design/http-gateway.md)
//   lazygate token|secret ...     gateway administration
//   lazygate migrate|revert|benchmark

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { ProcessManager } from "./process-manager.js";
import { createBroker } from "./broker.js";
import { META_TOOL_NAMES } from "./meta-tools.js";
import { loadRegistry } from "./registry.js";
import { adoptLegacyConfigDir, APP_NAME } from "./paths.js";
import { VERSION, LOG_PREFIX } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Subcommand dispatch ────────────────────────────────────────────────────

const SCRIPT_SUBCOMMANDS: Record<string, string> = {
  migrate: resolve(__dirname, "../scripts/migrate.mjs"),
  revert: resolve(__dirname, "../scripts/revert-migration.mjs"),
  benchmark: resolve(__dirname, "../scripts/benchmark.mjs"),
};

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  if (subcommand && SCRIPT_SUBCOMMANDS[subcommand]) {
    const result = spawnSync(process.execPath, [SCRIPT_SUBCOMMANDS[subcommand], ...rest], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  // Pick up a config directory from before the rename (context-broker → lazygate).
  adoptLegacyConfigDir();

  if (subcommand === "serve" || subcommand === "token" || subcommand === "secret") {
    const cli = await import("./gateway/cli.js");
    await cli.run(subcommand, rest);
    return;
  }

  await runStdio();
}

// ─── stdio mode ─────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const { router, skillRouter, toolIndex, serverConfigs } = loadRegistry(process.argv);

  const server = new Server(
    { name: APP_NAME, version: VERSION },
    { capabilities: { tools: { listChanged: true } } }
  );

  let connected = false;

  /** Tell the client the tool list changed so it re-fetches and can call tools directly. */
  const notifyToolsChanged = (): void => {
    if (!connected) return;
    server.sendToolListChanged().catch(() => {
      /* transport closed during shutdown */
    });
  };

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

  const shutdown = (): void => {
    connected = false;
    for (const name of manager.listActive()) manager.deactivate(name);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect first: auto-activation can take minutes (docker build, OAuth) and
  // notifications require a live transport.
  await server.connect(new StdioServerTransport());
  connected = true;
  console.error(`${LOG_PREFIX} Running on stdio`);

  // Auto-activate servers marked autoActivate: true (in the background)
  for (const [name, cfg] of Object.entries(serverConfigs)) {
    if (!cfg.autoActivate) continue;
    manager.activate(name, cfg).catch((err) => {
      console.error(`${LOG_PREFIX} Failed to auto-activate "${name}": ${(err as Error).message}`);
    });
  }
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} ${(err as Error).message}`);
  process.exit(1);
});
