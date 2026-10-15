// src/__tests__/migration-roundtrip.test.ts
// Runs the real migrate / session-sync / revert scripts as child processes against a
// throw-away HOME (child processes get an explicit env, so the real home is never touched).

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, lstatSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const scripts = (f: string) => fileURLToPath(new URL(`../../scripts/${f}`, import.meta.url));
const MIGRATE = scripts("migrate.mjs");
const REVERT = scripts("revert-migration.mjs");

const SKILL_ORIGINAL = "---\nname: foo\ndescription: Foo skill for testing\n---\n\n# Foo\nBody text\n";

let home: string;
const p = (...parts: string[]) => join(home, ...parts);
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const writeJson = (path: string, obj: unknown) => write(path, JSON.stringify(obj, null, 2) + "\n");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

function run(script: string, args: string[] = []) {
  return execFileSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, SHELL: "/bin/zsh" },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const sessionSync = () => run(p(".config", "lazygate", "scripts", "session-sync.mjs"));

function buildHome() {
  writeJson(p(".claude.json"), {
    numStartups: 3,
    mcpServers: {
      gh: { command: "npx", args: ["-y", "@x/server-github"], env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123" } },
      remote: { type: "http", url: "https://remote.example/mcp", headers: { Authorization: "Bearer supersecretvalue123" } },
    },
  });
  writeJson(p(".cursor", "mcp.json"), {
    mcpServers: { cur: { command: "node", args: ["x.js"], env: { API: "${env:SOME_VAR}" } } },
  });
  writeJson(p(".config", "opencode", "opencode.json"), {
    mcp: { oc: { type: "local", command: ["node", "y.js"], environment: { A: "1" } } },
  });

  // Same skill name in two sources → must not clobber each other.
  write(p(".claude", "skills", "foo", "SKILL.md"), SKILL_ORIGINAL);
  write(p(".cursor", "skills", "foo", "SKILL.md"), SKILL_ORIGINAL.replace("Foo skill", "Cursor foo"));

  // A plugin that ships a skill and an HTTP MCP server (named like the plugin).
  write(
    p(".claude", "plugins", "cache", "mkt", "slack", "1.0.0", "skills", "pskill", "SKILL.md"),
    "---\nname: pskill\ndescription: Plugin skill\n---\n\nPlugin body\n"
  );
  writeJson(p(".claude", "plugins", "cache", "mkt", "slack", "1.0.0", ".mcp.json"), {
    mcpServers: { slack: { type: "http", url: "https://mcp.slack.example/mcp" } },
  });
  writeJson(p(".claude", "settings.json"), { enabledPlugins: { "slack@mkt": true, "other@mkt": true } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cb-home-"));
  buildHome();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("migrate", () => {
  beforeEach(() => {
    run(MIGRATE);
  });

  it("converts servers, labelling each with where it came from", () => {
    const { servers } = readJson(p(".config", "lazygate", "servers.json"));
    expect(Object.keys(servers).sort()).toEqual(["cur", "gh", "oc", "remote", "slack"]);
    expect(servers.gh.migratedFrom).toBe("claude");
    expect(servers.cur.migratedFrom).toBe("cursor");
    expect(servers.oc.migratedFrom).toBe("opencode");
    // Plugin servers are labelled once as "plugin", not attributed to the last source scanned.
    expect(servers.slack.migratedFrom).toBe("plugin");
    expect(servers.oc.command).toBe("node");
    expect(servers.oc.args).toEqual(["y.js"]);
  });

  it("extracts env and header secrets to the shell file, leaving ${VAR} references", () => {
    const { servers } = readJson(p(".config", "lazygate", "servers.json"));
    expect(servers.gh.env.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
    expect(servers.remote.headers.Authorization).toBe("Bearer ${REMOTE_AUTHORIZATION}");
    const rc = readFileSync(p(".zshenv"), "utf-8");
    expect(rc).toContain('export GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123"');
    expect(rc).toContain('export REMOTE_AUTHORIZATION="supersecretvalue123"');
    expect(readFileSync(p(".config", "lazygate", "servers.json"), "utf-8")).not.toContain("supersecretvalue123");
  });

  it("normalises Cursor's ${env:VAR} syntax", () => {
    const { servers } = readJson(p(".config", "lazygate", "servers.json"));
    expect(servers.cur.env.API).toBe("${SOME_VAR}");
  });

  it("removes migrated entries from sources, backing the originals up first", () => {
    expect(readJson(p(".claude.json")).mcpServers.gh).toBeUndefined();
    expect(readJson(p(".claude.json")).numStartups).toBe(3); // unrelated keys untouched
    expect(Object.keys(readJson(p(".cursor", "mcp.json")).mcpServers)).toEqual(["lazygate"]);
    const backups = readdirSync(home).filter((f) => f.startsWith(".claude.json.bak-"));
    expect(backups.length).toBeGreaterThan(0);
    expect(readJson(p(backups[0])).mcpServers.gh).toBeDefined();
  });

  it("registers the broker in Cursor and OpenCode in each client's own format", () => {
    const cursor = readJson(p(".cursor", "mcp.json")).mcpServers["lazygate"];
    expect(typeof cursor.command).toBe("string");
    expect(Array.isArray(cursor.args)).toBe(true);

    const oc = readJson(p(".config", "opencode", "opencode.json")).mcp;
    expect(Object.keys(oc)).toEqual(["lazygate"]);
    expect(oc["lazygate"].type).toBe("local");
    expect(Array.isArray(oc["lazygate"].command)).toBe(true);
  });

  it("records exactly which plugins it disabled", () => {
    const { servers } = readJson(p(".config", "lazygate", "servers.json"));
    expect(servers.slack.disabledPlugins).toEqual(["slack@mkt"]);
    const { enabledPlugins } = readJson(p(".claude", "settings.json"));
    expect(enabledPlugins["slack@mkt"]).toBe(false);
    expect(enabledPlugins["other@mkt"]).toBe(true);
  });

  it("registers same-named skills from different sources under distinct keys", () => {
    const { skills } = readJson(p(".config", "lazygate", "skills.json"));
    expect(skills.foo.migratedFrom).toBe("claude");
    expect(skills["foo@cursor"].migratedFrom).toBe("cursor");
    expect(skills["foo@cursor"].path).toContain(".cursor");
  });

  it("splits SKILL.md into a stub that points at INSTRUCTIONS.md", () => {
    const stub = readFileSync(p(".claude", "skills", "foo", "SKILL.md"), "utf-8");
    expect(stub).toContain("description: Foo skill for testing");
    expect(stub).toContain("INSTRUCTIONS.md");
    expect(stub).not.toContain("Body text");
    expect(readFileSync(p(".claude", "skills", "foo", "INSTRUCTIONS.md"), "utf-8")).toBe("# Foo\nBody text\n");
  });

  it("installs session-sync with its lib and adds the hook", () => {
    expect(existsSync(p(".config", "lazygate", "scripts", "session-sync.mjs"))).toBe(true);
    expect(existsSync(p(".config", "lazygate", "scripts", "lib", "shared.mjs"))).toBe(true);
    const hooks = readJson(p(".claude", "settings.json")).hooks.SessionStart;
    expect(JSON.stringify(hooks)).toContain("session-sync.mjs");
  });

  it("is idempotent and preserves user edits to descriptions", () => {
    const path = p(".config", "lazygate", "servers.json");
    const edited = readJson(path);
    edited.servers.gh.description = "My GitHub server";
    writeJson(path, edited);

    run(MIGRATE);
    const again = readJson(path);
    expect(again.servers.gh.description).toBe("My GitHub server");
    expect(again.servers.gh.env.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
    // Secrets are not appended twice
    expect((readFileSync(p(".zshenv"), "utf-8").match(/export GITHUB_TOKEN=/g) ?? []).length).toBe(1);
  });
});

describe("session-sync", () => {
  it("keeps migratedFrom / plugin markers so revert still works afterwards", () => {
    run(MIGRATE);
    sessionSync();
    const { skills } = readJson(p(".config", "lazygate", "skills.json"));
    expect(skills.foo.migratedFrom).toBe("claude");
    expect(skills["foo@cursor"].migratedFrom).toBe("cursor");
    expect(skills["slack:pskill"].plugin).toBe("slack");
  });

  it("does not turn the stub pointer into the skill description", () => {
    write(p(".claude", "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n\nDoes the nodesc thing.\n");
    run(MIGRATE);
    sessionSync();
    const { skills } = readJson(p(".config", "lazygate", "skills.json"));
    expect(skills.nodesc.description).toBe("Does the nodesc thing.");
  });

  it("never fails the session on a corrupt registry", () => {
    run(MIGRATE);
    writeFileSync(p(".config", "lazygate", "skills.json"), "{ not json");
    expect(() => sessionSync()).not.toThrow();
  });
});

describe("revert", () => {
  it("restores everything migrate changed (migrate → session-sync → revert round trip)", () => {
    run(MIGRATE);
    sessionSync();
    run(REVERT);

    // Servers back in each client's own format
    const claude = readJson(p(".claude.json"));
    expect(claude.mcpServers.gh.command).toBe("npx");
    expect(claude.mcpServers.remote.url).toBe("https://remote.example/mcp");
    expect(claude.mcpServers["lazygate"]).toBeUndefined();

    const cursor = readJson(p(".cursor", "mcp.json"));
    expect(cursor.mcpServers.cur.env.API).toBe("${env:SOME_VAR}"); // Cursor syntax restored
    expect(cursor.mcpServers["lazygate"]).toBeUndefined(); // broker no longer needed there

    const opencode = readJson(p(".config", "opencode", "opencode.json"));
    expect(opencode.mcpServers).toBeUndefined(); // not Claude's format
    expect(opencode.mcp.oc).toEqual({ type: "local", command: ["node", "y.js"], environment: { A: "1" } });
    expect(opencode.mcp["lazygate"]).toBeUndefined();

    // Plugin re-enabled; plugin server not written into any client config
    expect(readJson(p(".claude", "settings.json")).enabledPlugins["slack@mkt"]).toBe(true);
    expect(JSON.stringify([claude, cursor, opencode])).not.toContain("mcp.slack.example");

    // Skills merged back byte-for-byte
    expect(readFileSync(p(".claude", "skills", "foo", "SKILL.md"), "utf-8")).toBe(SKILL_ORIGINAL);
    expect(existsSync(p(".claude", "skills", "foo", "INSTRUCTIONS.md"))).toBe(false);
    expect(readFileSync(p(".claude", "plugins", "cache", "mkt", "slack", "1.0.0", "skills", "pskill", "SKILL.md"), "utf-8"))
      .toBe("---\nname: pskill\ndescription: Plugin skill\n---\n\nPlugin body\n");

    // Registries empty, hook gone
    expect(readJson(p(".config", "lazygate", "servers.json")).servers).toEqual({});
    expect(readJson(p(".config", "lazygate", "skills.json")).skills).toEqual({});
    expect(JSON.stringify(readJson(p(".claude", "settings.json")).hooks?.SessionStart ?? [])).not.toContain("session-sync");
  });

  it("keeps the broker registered when only one source is reverted", () => {
    run(MIGRATE);
    run(REVERT, ["--from", "cursor", "--servers"]);

    expect(readJson(p(".cursor", "mcp.json")).mcpServers.cur).toBeDefined();
    expect(readJson(p(".cursor", "mcp.json")).mcpServers["lazygate"]).toBeUndefined();
    expect(readJson(p(".config", "opencode", "opencode.json")).mcp["lazygate"]).toBeDefined(); // not reverted
    const claude = readJson(p(".claude.json"));
    expect(claude.mcpServers["lazygate"]).toBeDefined(); // gh/remote still managed
    const { servers } = readJson(p(".config", "lazygate", "servers.json"));
    expect(servers.cur).toBeUndefined();
    expect(servers.gh).toBeDefined();
  });

  it("still finds entries by the legacy 'Migrated from' description", () => {
    run(MIGRATE);
    const path = p(".config", "lazygate", "servers.json");
    const f = readJson(path);
    f.servers.cur = { ...f.servers.cur, description: "Migrated from cursor" };
    delete f.servers.cur.migratedFrom;
    writeJson(path, f);

    run(REVERT, ["--from", "cursor", "--servers"]);
    expect(readJson(p(".cursor", "mcp.json")).mcpServers.cur).toBeDefined();
  });
});

describe("upgrade from the pre-rename install (context-broker)", () => {
  const LEGACY_STUB =
    "---\nname: old\ndescription: Old skill\n---\n\n" +
    "<!-- context-broker: full instructions are in INSTRUCTIONS.md next to this file; load them with the context-broker load_skill tool -->\n";

  beforeEach(() => {
    writeJson(p(".config", "context-broker", "servers.json"), {
      servers: {
        old: { description: "kept", keywords: ["old"], command: "node", args: ["o.js"], autoActivate: false, migratedFrom: "claude" },
      },
    });
    write(p(".config", "context-broker", "tool-index.json"), "{}");

    const claude = readJson(p(".claude.json"));
    claude.mcpServers["context-broker"] = { command: "node", args: ["/old/dist/index.js"] };
    writeJson(p(".claude.json"), claude);

    const settings = readJson(p(".claude", "settings.json"));
    settings.hooks = {
      SessionStart: [{ hooks: [{ type: "command", command: "node ~/.config/context-broker/scripts/session-sync.mjs" }] }],
    };
    writeJson(p(".claude", "settings.json"), settings);

    write(p(".claude", "skills", "old", "SKILL.md"), LEGACY_STUB);
    write(p(".claude", "skills", "old", "INSTRUCTIONS.md"), "# Old\nBody\n");
  });

  it("moves the config dir (leaving a symlink) and keeps existing entries", () => {
    run(MIGRATE);
    expect(existsSync(p(".config", "lazygate", "tool-index.json"))).toBe(true);
    expect(lstatSync(p(".config", "context-broker")).isSymbolicLink()).toBe(true);
    const { servers } = readJson(p(".config", "lazygate", "servers.json"));
    expect(servers.old.description).toBe("kept");
    expect(servers.gh).toBeDefined();
  });

  it("replaces the legacy broker entry and session hook", () => {
    run(MIGRATE);
    const claude = readJson(p(".claude.json"));
    expect(claude.mcpServers.lazygate).toBeDefined();
    expect(claude.mcpServers["context-broker"]).toBeUndefined();

    const hooks = JSON.stringify(readJson(p(".claude", "settings.json")).hooks.SessionStart);
    expect(hooks).toContain(".config/lazygate/scripts/session-sync.mjs");
    expect(hooks).not.toContain("context-broker");
    expect(readJson(p(".claude", "settings.json")).hooks.SessionStart).toHaveLength(1);
  });

  it("does not touch the config dir on --dry-run", () => {
    run(MIGRATE, ["--dry-run"]);
    expect(existsSync(p(".config", "lazygate"))).toBe(false);
    expect(lstatSync(p(".config", "context-broker")).isDirectory()).toBe(true);
  });

  it("still merges stubs written with the old marker on revert", () => {
    run(MIGRATE);
    run(REVERT);
    const restored = readFileSync(p(".claude", "skills", "old", "SKILL.md"), "utf-8");
    expect(restored).toContain("Body");
    expect(restored).not.toContain("context-broker");
    expect(existsSync(p(".claude", "skills", "old", "INSTRUCTIONS.md"))).toBe(false);
    expect(readJson(p(".claude.json")).mcpServers.lazygate).toBeUndefined();
  });
});
