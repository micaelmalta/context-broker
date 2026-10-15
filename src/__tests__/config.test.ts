// src/__tests__/config.test.ts
// Config validation, scoring semantics, and on-disk reload behaviour.

import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseServersConfig, parseSkillsConfig } from "../config.js";
import { scoreEntry, tokenize } from "../scoring.js";
import { ToolRouter } from "../router.js";
import { SkillRouter } from "../skill-router.js";

describe("parseServersConfig", () => {
  it("applies defaults and keeps valid entries", () => {
    const { entries, errors } = parseServersConfig({ servers: { a: { command: "node" } } });
    expect(errors).toEqual([]);
    expect(entries.a).toMatchObject({ command: "node", keywords: [], description: "", autoActivate: false });
  });

  it("names the offending entry and keeps the good ones", () => {
    const { entries, errors } = parseServersConfig(
      {
        servers: {
          good: { command: "node", keywords: ["x"] },
          noTransport: { description: "x" },
          badKeywords: { command: "node", keywords: "oops" },
          badOauth: { type: "http", url: "https://x.example/mcp", oauth: { callbackPort: "nope" } },
        },
      },
      "servers.json"
    );
    expect(Object.keys(entries)).toEqual(["good"]);
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toMatch(/servers\.noTransport — .*command.*url/);
    expect(errors.join("\n")).toMatch(/servers\.badKeywords — keywords/);
    expect(errors.join("\n")).toMatch(/servers\.badOauth/);
  });

  it("accepts oauth as boolean or object, and unknown extra fields", () => {
    const { entries, errors } = parseServersConfig({
      servers: {
        a: { url: "https://x.example/mcp", type: "http", oauth: true },
        b: { url: "https://x.example/mcp", type: "http", oauth: { clientId: "c", callbackPort: 3118 } },
        c: { command: "node", somethingNew: 1 },
      },
    });
    expect(errors).toEqual([]);
    expect(Object.keys(entries)).toEqual(["a", "b", "c"]);
  });

  it("throws on structurally invalid files", () => {
    expect(() => parseServersConfig(null)).toThrow(/JSON object/);
    expect(() => parseServersConfig({ servers: [] })).toThrow(/keyed by name/);
  });

  it("treats a missing servers key as empty", () => {
    expect(parseServersConfig({}).entries).toEqual({});
  });
});

describe("parseSkillsConfig", () => {
  it("requires a path", () => {
    const { entries, errors } = parseSkillsConfig({ skills: { ok: { path: "/x/SKILL.md" }, bad: { description: "x" } } });
    expect(Object.keys(entries)).toEqual(["ok"]);
    expect(errors[0]).toMatch(/skills\.bad — path/);
  });
});

describe("scoring", () => {
  it("matches whole words only", () => {
    expect(scoreEntry("a digital prompt", { keywords: ["git", "pr"] }).score).toBe(0);
    expect(scoreEntry("open a git pr", { keywords: ["git", "pr"] }).score).toBe(4);
  });

  it("ignores punctuation", () => {
    const e = { description: "Manage repositories and issues", keywords: [] };
    expect(scoreEntry("list repositories,", e).score).toBe(1);
    expect(scoreEntry("list repositories", e).score).toBe(1);
  });

  it("matches multi-word keywords as phrases", () => {
    const e = { keywords: ["pull request"] };
    expect(scoreEntry("review this pull request", e).keywords).toEqual(["pull request"]);
    expect(scoreEntry("pull the request", e).keywords).toEqual([]);
  });

  it("handles simple plurals on both sides", () => {
    expect(scoreEntry("show my issues", { keywords: ["issue"] }).score).toBe(2);
    expect(scoreEntry("show my issue", { keywords: ["issues"] }).score).toBe(2);
  });

  it("reports description matches separately and counts each word once", () => {
    const r = scoreEntry("search repositories", {
      description: "repositories repositories everywhere",
      keywords: ["search"],
    });
    expect(r.keywords).toEqual(["search"]);
    expect(r.descriptionWords).toEqual(["repositories"]);
    expect(r.score).toBe(3);
  });

  it("tolerates missing fields", () => {
    expect(scoreEntry("x", {}).score).toBe(0);
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });
});

describe("reload from disk", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("ToolRouter picks up edits and keeps the old config on a bad file", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-cfg-"));
    const path = join(dir, "servers.json");
    writeFileSync(path, JSON.stringify({ servers: { a: { command: "node", keywords: ["alpha"] } } }));
    const router = new ToolRouter(parseServersConfig(JSON.parse(JSON.stringify({ servers: { a: { command: "node", keywords: ["alpha"] } } }))).entries, path);

    writeFileSync(path, JSON.stringify({ servers: { a: { command: "node" }, b: { command: "node" } } }));
    expect(router.reloadServersFromDisk()).toBe(true);
    expect(router.listAll()).toEqual(["a", "b"]);

    writeFileSync(path, "{ half written");
    expect(router.reloadServersFromDisk()).toBe(false);
    expect(router.listAll()).toEqual(["a", "b"]);
  });

  it("SkillRouter reloads skills.json lazily", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-cfg-"));
    const path = join(dir, "skills.json");
    writeFileSync(path, JSON.stringify({ skills: {} }));
    const skills = new SkillRouter({}, path);

    writeFileSync(path, JSON.stringify({ skills: { s: { description: "x", keywords: ["s"], path: "/x/SKILL.md" } } }));
    expect(skills.reloadFromDisk()).toBe(true);
    expect(skills.listAll()).toEqual(["s"]);

    writeFileSync(path, "");
    expect(skills.reloadFromDisk()).toBe(false);
    expect(skills.listAll()).toEqual(["s"]);
  });
});
