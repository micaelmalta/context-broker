// src/broker.ts
// Request handling for the broker, independent of the stdio transport so it can be tested.

import type { z } from "zod";
import type { ToolRouter, ServerConfig } from "./router.js";
import type { SkillRouter } from "./skill-router.js";
import type { ProcessManager, RuntimeCredentials } from "./process-manager.js";
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

/** Per-caller access rules (gateway mode). Without it every configured server is usable. */
export interface BrokerAccess {
  /** Whether this caller may see and use the server. */
  canUse(name: string, cfg: ServerConfig): boolean;
  /**
   * Resolve the caller's credentials for the server. Throws an Error with a user-facing message
   * (e.g. which header to send) when something required is missing.
   */
  prepare(name: string, cfg: ServerConfig): RuntimeCredentials | undefined;
  /** What the caller still has to provide before the server can be activated (shown by discover_tools). */
  missing?(name: string, cfg: ServerConfig): string[];
}

export interface BrokerDeps {
  router: ToolRouter;
  manager: ProcessManager;
  skillRouter: SkillRouter | null;
  access?: BrokerAccess;
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

const SUMMARY_MAX = 160;
/** Above this many tools, activation lists names only (the schemas carry the details). */
const DETAILED_LIST_MAX_TOOLS = 12;

export function formatActivation(serverName: string, tools: Array<{ name: string; description?: string }>): string {
  if (tools.length > DETAILED_LIST_MAX_TOOLS) {
    return (
      `✓ Activated "${serverName}" with ${tools.length} tools (names only; descriptions are in the tool schemas):\n` +
      tools.map((t) => t.name).join(", ")
    );
  }
  return (
    `✓ Activated "${serverName}" with ${tools.length} tools (first sentence of each; ` +
    `full descriptions are in the tool schemas):\n` +
    tools.map((t) => `  • ${t.name}: ${summarizeDescription(t.description)}`).join("\n")
  );
}

/**
 * First sentence of a tool description, capped in length. Activation output uses this so a
 * server with dozens of tools doesn't dump its full documentation into the context window —
 * the complete descriptions are still in each tool's schema (tools/list).
 */
export function summarizeDescription(description: string | undefined, max = SUMMARY_MAX): string {
  const flat = (description ?? "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
  let end = flat.length;
  for (const m of flat.matchAll(/[.!?](?=\s|$)/g)) {
    const i = m.index!;
    if (/(?:e\.g|i\.e|etc|vs)$/i.test(flat.slice(0, i))) continue; // abbreviation, not a sentence end
    end = i + 1;
    break;
  }
  const sentence = flat.slice(0, end);
  return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + "…" : sentence;
}

export function createBroker({ router, manager, skillRouter, access }: BrokerDeps) {
  /** Servers this caller may see. Hidden servers behave exactly like unknown ones. */
  const visible = (name: string): boolean => {
    const cfg = router.getConfig(name);
    return Boolean(cfg) && (!access || access.canUse(name, cfg!));
  };
  const visibleNames = (): string[] => router.listAll().filter(visible);

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
        const ranked = router.rank(a.query).filter((r) => visible(r.name));

        if (ranked.length === 0) {
          const all = visibleNames();
          return text(
            `No matching servers found for: "${a.query}"\n\nAvailable servers:\n` +
              (all.length
                ? all.map((n) => `• ${n}: ${router.getConfig(n)!.description}`).join("\n")
                : "(none configured — add entries to ~/.config/lazygate/servers.json)")
          );
        }

        const active = manager.listActive();
        const lines = ranked.map((r) => {
          const cfg = router.getConfig(r.name)!;
          const missing = active.includes(r.name) ? [] : access?.missing?.(r.name, cfg) ?? [];
          const status = active.includes(r.name) ? "✓ active" : missing.length ? "⚠ needs credentials" : "○ inactive";
          const needs = missing.length ? `\n  Needs: ${missing.join(", ")}` : "";
          return `${status} | ${r.name} (score: ${r.score})\n  ${cfg.description}\n  Matched ${matchedLine(r.reason, r.descriptionMatches, r.toolMatches)}${needs}`;
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
        if (!cfg || !visible(a.server_name)) {
          return fail(
            `Unknown server: "${a.server_name}". Available: ${visibleNames().join(", ") || "(none)"}`
          );
        }
        try {
          const tools = await manager.activate(a.server_name, cfg, access?.prepare(a.server_name, cfg));
          return text(formatActivation(a.server_name, tools));
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
      const candidate = router.select(name, 10).find(visible);
      const cfg = candidate ? router.getConfig(candidate) : undefined;
      if (candidate && cfg) {
        try {
          await manager.activate(candidate, cfg, access?.prepare(candidate, cfg));
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
