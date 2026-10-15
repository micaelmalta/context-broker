// src/__tests__/tool-index.test.ts
// Learned tool index (routing by tool descriptions) and child environment scoping.

import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ToolIndex, toolText } from "../tool-index.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import { scoreEntry } from "../scoring.js";
import { buildChildEnv } from "../child-env.js";

const server = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "migrated server",
  keywords: ["acme"],
  command: "node",
  args: ["acme.js"],
  autoActivate: false,
  ...o,
});

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("ToolIndex", () => {
  it("records, persists and reloads a server's tools", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-idx-"));
    const path = join(dir, "tool-index.json");
    const cfg = server();

    const a = new ToolIndex(path);
    expect(a.record("acme", cfg, [{ name: "create_invoice", description: "Create an invoice" }])).toBe(true);
    expect(a.record("acme", cfg, [{ name: "create_invoice", description: "Create an invoice" }])).toBe(false); // unchanged

    const b = new ToolIndex(path);
    expect(b.get("acme", cfg).map((t) => t.name)).toEqual(["create_invoice"]);
  });

  it("ignores the index when the server's command changes", () => {
    const idx = new ToolIndex();
    idx.record("acme", server(), [{ name: "t", description: "d" }]);
    expect(idx.get("acme", server({ args: ["other.js"] }))).toEqual([]);
  });

  it("survives a corrupt cache file", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-idx-"));
    const path = join(dir, "tool-index.json");
    writeFileSync(path, "{ nope");
    const idx = new ToolIndex(path);
    expect(idx.get("x", server())).toEqual([]);
    idx.record("x", server(), []);
    expect(existsSync(path)).toBe(true);
  });

  it("truncates long descriptions", () => {
    const idx = new ToolIndex();
    idx.record("acme", server(), [{ name: "t", description: "x".repeat(1000) }]);
    expect(idx.get("acme", server())[0].description).toHaveLength(200);
  });

  it("toolText splits tool names on _ and -", () => {
    expect(toolText([{ name: "list_open-issues", description: "Lists issues" }])).toBe("list open issues Lists issues");
  });
});

describe("routing by learned tools", () => {
  it("finds a generic server once its tools are known — and not before", () => {
    const idx = new ToolIndex();
    const cfg = server({ description: "acme MCP server", keywords: ["acme"] });
    const router = new ToolRouter({ acme: cfg }, undefined, idx);

    expect(router.rank("send an invoice reminder")).toEqual([]);

    idx.record("acme", cfg, [
      { name: "create_invoice", description: "Create an invoice for a customer" },
      { name: "send_reminder", description: "Send a payment reminder" },
    ]);
    const [hit] = router.rank("send an invoice reminder");
    expect(hit.name).toBe("acme");
    expect(hit.toolMatches.sort()).toEqual(["invoice", "reminder"]);
  });

  it("caps the tool contribution so keywords still dominate", () => {
    const r = scoreEntry("invoice reminder payment customer", {
      keywords: [],
      toolText: "create invoice customer payment reminder",
    });
    expect(r.toolWords.length).toBe(4);
    expect(r.score).toBe(2);

    const kw = scoreEntry("acme invoice", { keywords: ["acme"], toolText: "create invoice" });
    expect(kw.score).toBe(3);
  });

  it("does not double count words already matched by description or keywords", () => {
    const r = scoreEntry("invoices", { description: "Manage invoices", toolText: "create invoices" });
    expect(r.descriptionWords).toEqual(["invoices"]);
    expect(r.toolWords).toEqual([]);
  });
});

describe("buildChildEnv", () => {
  const parent = {
    PATH: "/bin",
    HOME: "/home/u",
    LC_ALL: "C",
    npm_config_registry: "https://r.example",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "ghp_x",
  } as NodeJS.ProcessEnv;

  it("inherits everything by default", () => {
    expect(buildChildEnv(parent, undefined, { A: "1" })).toEqual({ ...parent, A: "1" });
    expect(buildChildEnv(parent, true, {})).toEqual(parent);
  });

  it("false → only the base set (no secrets), plus own env", () => {
    const env = buildChildEnv(parent, false, { OWN: "1" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", LC_ALL: "C", npm_config_registry: "https://r.example", OWN: "1" });
  });

  it("list → base plus named variables, with prefix globs", () => {
    const env = buildChildEnv(parent, ["GITHUB_TOKEN", "AWS_*"], {});
    expect(env.GITHUB_TOKEN).toBe("ghp_x");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(env.PATH).toBe("/bin");
  });

  it("own env always wins and matching is case-insensitive", () => {
    const env = buildChildEnv({ path: "/x", Foo: "1" } as NodeJS.ProcessEnv, ["FOO"], { PATH: "/own" });
    expect(env.path).toBe("/x");
    expect(env.Foo).toBe("1");
    expect(env.PATH).toBe("/own");
  });
});
