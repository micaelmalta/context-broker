// src/__tests__/broker.test.ts
// Handler tests for createBroker (meta-tools + proxying) using stub dependencies.

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createBroker, summarizeDescription } from "../broker.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import { SkillRouter } from "../skill-router.js";
import type { ProcessManager, MCPTool } from "../process-manager.js";

const server = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "Test server",
  keywords: [],
  command: "node",
  autoActivate: false,
  ...o,
});

function makeManager() {
  const active = new Map<string, MCPTool[]>();
  const manager = {
    activate: jest.fn(async (name: string, _cfg: ServerConfig) => {
      const tools: MCPTool[] = [{ name: `${name}_tool`, description: "d", inputSchema: {}, serverName: name }];
      active.set(name, tools);
      return tools;
    }),
    deactivate: jest.fn((name: string) => active.delete(name)),
    listActive: jest.fn(() => [...active.keys()]),
    getAllActiveTools: jest.fn(() => [...active.values()].flat()),
    findServerForTool: jest.fn((tool: string) =>
      [...active.entries()].find(([, ts]) => ts.some((t) => t.name === tool))?.[0]
    ),
    callTool: jest.fn(async (_s: string, _t: string, _a: Record<string, unknown>) => ({
      content: [{ type: "text", text: "called" }],
    })),
  };
  return { manager, active };
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("createBroker", () => {
  let router: ToolRouter;
  let mk: ReturnType<typeof makeManager>;
  let broker: ReturnType<typeof createBroker>;

  beforeEach(() => {
    router = new ToolRouter({
      github: server({ description: "GitHub repositories and issues", keywords: ["github", "issue"] }),
      postgres: server({ description: "PostgreSQL queries", keywords: ["postgres", "sql"] }),
    });
    mk = makeManager();
    broker = createBroker({
      router,
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: null,
    });
  });

  it("lists the six meta-tools plus active server tools (prefixed)", async () => {
    expect(broker.listTools().tools).toHaveLength(6);
    await broker.callTool("activate_server", { server_name: "github" });
    const tools = broker.listTools().tools;
    expect(tools).toHaveLength(7);
    expect(tools.at(-1)!.description).toMatch(/^\[github\]/);
  });

  describe("argument validation", () => {
    it.each([
      ["discover_tools", {}],
      ["discover_tools", { query: 5 }],
      ["activate_server", undefined],
      ["deactivate_server", { server_name: "" }],
    ])("%s rejects bad args with isError instead of throwing", async (name, args) => {
      const r = await broker.callTool(name, args as Record<string, unknown> | undefined);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Invalid arguments/);
    });
  });

  describe("discover_tools", () => {
    it("ranks servers and marks active state", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      const r = await broker.callTool("discover_tools", { query: "list github issues" });
      expect(r.isError).toBeUndefined();
      expect(text(r)).toContain("✓ active | github");
      expect(text(r)).not.toContain("postgres");
    });

    it("shows description matches when no keyword matched", async () => {
      const r = await broker.callTool("discover_tools", { query: "repositories" });
      expect(text(r)).toMatch(/Matched description: repositories/);
    });

    it("does not route 'digital' or 'prompt' to a server with keywords 'git'/'pr'", async () => {
      router = new ToolRouter({ gh: server({ description: "Code hosting", keywords: ["git", "pr"] }) });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
      const r = await broker.callTool("discover_tools", { query: "improve the prompt for a digital app" });
      expect(text(r)).toMatch(/No matching servers/);
    });

    it("reports an empty registry helpfully", async () => {
      router = new ToolRouter({});
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
      const r = await broker.callTool("discover_tools", { query: "anything" });
      expect(text(r)).toMatch(/none configured/);
    });
  });

  describe("activate / deactivate", () => {
    it("activates a known server", async () => {
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(text(r)).toMatch(/Activated "github" with 1 tools/);
    });

    it("lists only the first sentence of each tool description on activation", async () => {
      const long =
        "Generate a plan and open an investigation.\n\nUSE WHEN: the request is to debug.\nRULES:\n1. " + "x".repeat(2000);
      mk.manager.activate.mockResolvedValueOnce([
        { name: "investigate", description: long, inputSchema: {}, serverName: "github" },
      ]);
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(text(r)).toContain("• investigate: Generate a plan and open an investigation.");
      expect(text(r)).not.toContain("USE WHEN");
      expect(text(r).length).toBeLessThan(400);
    });

    it("lists names only for servers with many tools", async () => {
      const many = Array.from({ length: 31 }, (_, i) => ({
        name: `tool_${i}`,
        description: "Does a thing. With lots of detail that should not be repeated.",
        inputSchema: {},
        serverName: "github",
      }));
      mk.manager.activate.mockResolvedValueOnce(many);
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(text(r)).toMatch(/with 31 tools \(names only/);
      expect(text(r)).toContain("tool_0, tool_1");
      expect(text(r)).not.toContain("Does a thing");
      expect(text(r).length).toBeLessThan(500);
    });

    it("flags unknown servers as errors", async () => {
      const r = await broker.callTool("activate_server", { server_name: "nope" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Unknown server/);
    });

    it("flags activation failures as errors", async () => {
      mk.manager.activate.mockRejectedValueOnce(new Error("spawn ENOENT"));
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Failed to activate "github": spawn ENOENT/);
    });

    it("deactivate reports unknown / inactive servers as errors", async () => {
      const r = await broker.callTool("deactivate_server", { server_name: "github" });
      expect(r.isError).toBe(true);
      await broker.callTool("activate_server", { server_name: "github" });
      const ok = await broker.callTool("deactivate_server", { server_name: "github" });
      expect(ok.isError).toBeUndefined();
      expect(text(ok)).toBe('Deactivated "github"');
    });
  });

  describe("list_active_servers", () => {
    it("handles none and some", async () => {
      expect(text(await broker.callTool("list_active_servers", {}))).toBe("No servers currently active.");
      await broker.callTool("activate_server", { server_name: "github" });
      expect(text(await broker.callTool("list_active_servers", {}))).toContain("github_tool");
    });
  });

  describe("proxying", () => {
    it("forwards calls for active tools", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      const r = await broker.callTool("github_tool", { a: 1 });
      expect(text(r)).toBe("called");
      expect(mk.manager.callTool).toHaveBeenCalledWith("github", "github_tool", { a: 1 });
    });

    it("returns isError when the proxied call throws", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      mk.manager.callTool.mockRejectedValueOnce(new Error("timed out"));
      const r = await broker.callTool("github_tool", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Error calling github_tool: timed out/);
    });

    it("auto-activates the best match for an unknown tool name", async () => {
      // 'github_tool' tokenises to github + tool → matches the github server
      const r = await broker.callTool("github_tool", {});
      expect(text(r)).toBe("called");
      expect(mk.manager.activate).toHaveBeenCalledWith("github", expect.anything(), undefined);
    });

    it("turns auto-activation failures into tool errors instead of throwing", async () => {
      mk.manager.activate.mockRejectedValueOnce(new Error("boom"));
      const r = await broker.callTool("github_tool", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/auto-activating "github" failed: boom/);
    });

    it("reports truly unknown tools as errors", async () => {
      const r = await broker.callTool("zzz_unknown", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not found/);
    });
  });

  describe("skills", () => {
    it("reports a missing registry as an error", async () => {
      expect((await broker.callTool("discover_skill", { query: "x" })).isError).toBe(true);
      expect((await broker.callTool("load_skill", { skill_name: "x" })).isError).toBe(true);
    });

    it("discovers and loads skills", async () => {
      const { mkdtempSync, writeFileSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const dir = mkdtempSync(join(tmpdir(), "cb-skill-"));
      writeFileSync(join(dir, "SKILL.md"), "---\n---\n");
      writeFileSync(join(dir, "INSTRUCTIONS.md"), "Do the thing");

      const skills = new SkillRouter({
        pdf: { description: "Work with PDF files", keywords: ["pdf"], path: join(dir, "SKILL.md") },
      });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: skills });

      const d = await broker.callTool("discover_skill", { query: "merge a pdf" });
      expect(text(d)).toMatch(/pdf \(score: 2\)/);
      const l = await broker.callTool("load_skill", { skill_name: "pdf" });
      expect(text(l)).toBe("# Skill: pdf\n\nDo the thing");
      const bad = await broker.callTool("load_skill", { skill_name: "nope" });
      expect(bad.isError).toBe(true);
    });
  });
});

describe("summarizeDescription", () => {
  it("takes the first sentence and collapses whitespace", () => {
    expect(summarizeDescription("Search code.  Returns\nchunks. More text.")).toBe("Search code.");
  });
  it("stops at a blank line when there is no full stop", () => {
    expect(summarizeDescription("List all services\n\nUSE WHEN: x")).toBe("List all services");
  });
  it("does not split on e.g. / i.e.", () => {
    expect(summarizeDescription("Find a thing (e.g. a file) by name. Extra.")).toBe("Find a thing (e.g. a file) by name.");
  });
  it("caps long sentences with an ellipsis", () => {
    const out = summarizeDescription("a".repeat(500));
    expect(out).toHaveLength(160);
    expect(out.endsWith("…")).toBe(true);
  });
  it("handles missing descriptions", () => {
    expect(summarizeDescription(undefined)).toBe("");
  });
});
