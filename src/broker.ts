// src/broker.ts
// Request handling for the broker, independent of the stdio transport so it can be tested.

import type { z } from "zod";
import type { ToolRouter } from "./router.js";
import type { SkillRouter } from "./skill-router.js";
import type { ProcessManager } from "./process-manager.js";
import {
  META_TOOLS,
  QuerySchema,
  ServerNameSchema,
  SkillNameSchema,
} from "./meta-tools.js";
import { LOG_PREFIX } from "./version.js";

export interface ToolResult {
  content: unknown[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface BrokerDeps {
  router: ToolRouter;
  manager: ProcessManager;
  skillRouter: SkillRouter | null;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function fail(t: string): ToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

function matchedLine(keywords: string[], descriptionWords: string[], toolWords: string[] = []): string {
  const parts: string[] = [];
  if (keywords.length) parts.push(`keywords: ${keywords.join(", ")}`);
  if (descriptionWords.length) parts.push(`description: ${descriptionWords.join(", ")}`);
  if (toolWords.length) parts.push(`tools: ${toolWords.join(", ")}`);
  return parts.join(" | ") || "—";
}

export function createBroker({ router, manager, skillRouter }: BrokerDeps) {
  function listTools() {
    const activeTools = manager.getAllActiveTools().map((t) => ({
      name: t.name,
      description: `[${t.serverName}] ${t.description}`,
      inputSchema: t.inputSchema,
    }));
    return { tools: [...META_TOOLS, ...activeTools] };
  }

  function parseArgs<S extends z.ZodTypeAny>(schema: S, args: unknown): z.infer<S> | ToolResult {
    const parsed = schema.safeParse(args ?? {});
    if (parsed.success) return parsed.data;
    return fail(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const isResult = (v: unknown): v is ToolResult =>
    typeof v === "object" && v !== null && "content" in v && Array.isArray((v as ToolResult).content);

  async function callTool(name: string, rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
    switch (name) {
      case "discover_tools": {
        const a = parseArgs(QuerySchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const ranked = router.rank(a.query);

        if (ranked.length === 0) {
          const all = router.listAll();
          return text(
            `No matching servers found for: "${a.query}"\n\nAvailable servers:\n` +
              (all.length
                ? all.map((n) => `• ${n}: ${router.getConfig(n)!.description}`).join("\n")
                : "(none configured — add entries to ~/.config/context-broker/servers.json)")
          );
        }

        const active = manager.listActive();
        const lines = ranked.map((r) => {
          const cfg = router.getConfig(r.name)!;
          const status = active.includes(r.name) ? "✓ active" : "○ inactive";
          return `${status} | ${r.name} (score: ${r.score})\n  ${cfg.description}\n  Matched ${matchedLine(r.reason, r.descriptionMatches, r.toolMatches)}`;
        });
        return text(
          `Servers relevant to "${a.query}":\n\n${lines.join("\n\n")}\n\n` +
            `Use activate_server to load an inactive server.`
        );
      }

      case "activate_server": {
        const a = parseArgs(ServerNameSchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const cfg = router.getConfig(a.server_name);
        if (!cfg) {
          return fail(
            `Unknown server: "${a.server_name}". Available: ${router.listAll().join(", ") || "(none)"}`
          );
        }
        try {
          const tools = await manager.activate(a.server_name, cfg);
          return text(
            `✓ Activated "${a.server_name}" with ${tools.length} tools:\n` +
              tools.map((t) => `  • ${t.name}: ${t.description}`).join("\n")
          );
        } catch (err) {
          return fail(`Failed to activate "${a.server_name}": ${(err as Error).message}`);
        }
      }

      case "deactivate_server": {
        const a = parseArgs(ServerNameSchema, rawArgs);
        if (isResult(a)) return a;
        if (!manager.deactivate(a.server_name)) {
          const active = manager.listActive();
          return fail(
            `Server "${a.server_name}" is not active. Active: ${active.join(", ") || "(none)"}`
          );
        }
        return text(`Deactivated "${a.server_name}"`);
      }

      case "list_active_servers": {
        const active = manager.listActive();
        if (active.length === 0) return text("No servers currently active.");
        const allTools = manager.getAllActiveTools();
        return text(
          active
            .map((n) => {
              const tools = allTools
                .filter((t) => t.serverName === n)
                .map((t) => `    • ${t.name}`)
                .join("\n");
              return `${n}:\n${tools}`;
            })
            .join("\n\n")
        );
      }

      case "discover_skill": {
        if (!skillRouter) return fail("No skills registry configured.");
        const a = parseArgs(QuerySchema, rawArgs);
        if (isResult(a)) return a;
        skillRouter.reloadFromDisk();
        const ranked = skillRouter.rank(a.query);

        if (ranked.length === 0) {
          return text(
            `No matching skills found for: "${a.query}"\n\nAvailable skills:\n` +
              skillRouter
                .listAll()
                .map((n) => `• ${n}: ${skillRouter.getConfig(n)!.description}`)
                .join("\n")
          );
        }

        const lines = ranked.map((r) => {
          const cfg = skillRouter.getConfig(r.name)!;
          return `${r.name} (score: ${r.score})\n  ${cfg.description}\n  Matched ${matchedLine(r.reason, r.descriptionMatches)}`;
        });
        return text(
          `Skills relevant to "${a.query}":\n\n${lines.join("\n\n")}\n\n` +
            `Use load_skill to load a skill's full instructions.`
        );
      }

      case "load_skill": {
        if (!skillRouter) return fail("No skills registry configured.");
        const a = parseArgs(SkillNameSchema, rawArgs);
        if (isResult(a)) return a;
        if (!skillRouter.getConfig(a.skill_name)) skillRouter.reloadFromDisk();
        try {
          return text(`# Skill: ${a.skill_name}\n\n${skillRouter.load(a.skill_name)}`);
        } catch (err) {
          return fail((err as Error).message);
        }
      }
    }

    // ── Proxy to an active server ─────────────────────────────────────────
    let serverName = manager.findServerForTool(name);

    if (!serverName) {
      // Best-effort auto-activation based on the tool name.
      router.reloadServersFromDisk();
      const candidate = router.select(name, 1)[0];
      const cfg = candidate ? router.getConfig(candidate) : undefined;
      if (candidate && cfg) {
        try {
          await manager.activate(candidate, cfg);
          serverName = manager.findServerForTool(name);
        } catch (err) {
          console.error(`${LOG_PREFIX} auto-activation of "${candidate}" failed: ${(err as Error).message}`);
          return fail(
            `Tool "${name}" not found, and auto-activating "${candidate}" failed: ${(err as Error).message}`
          );
        }
      }
    }

    if (!serverName) {
      return fail(`Tool "${name}" not found. Use discover_tools to find and activate the right server.`);
    }

    try {
      return (await manager.callTool(serverName, name, rawArgs ?? {})) as ToolResult;
    } catch (err) {
      return fail(`Error calling ${name}: ${(err as Error).message}`);
    }
  }

  return { listTools, callTool };
}
