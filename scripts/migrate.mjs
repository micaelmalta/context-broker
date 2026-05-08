#!/usr/bin/env node
// Migrates MCP server configs from Cursor, Claude Code, or OpenCode into
// ~/.config/mcp-broker/servers.json.
// Detected secrets are extracted to ~/.zshenv and replaced with ${VAR} refs.
//
// Usage:
//   node scripts/migrate.mjs --from cursor
//   node scripts/migrate.mjs --from claude
//   node scripts/migrate.mjs --from opencode
//   node scripts/migrate.mjs --from /path/to/file
//   node scripts/migrate.mjs --from cursor --out /custom/servers.json
//   node scripts/migrate.mjs --from cursor --dry-run

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const fromArg = get("--from");
const outArg  = get("--out");
const dryRun  = has("--dry-run");

if (!fromArg) {
  console.error("Usage: migrate.mjs --from <cursor|claude|opencode|/path/to/file> [--out <path>] [--dry-run]");
  process.exit(1);
}

// ─── Resolve source file ───────────────────────────────────────────────────

const SOURCES = {
  cursor:   resolve(homedir(), ".cursor", "mcp.json"),
  claude:   resolve(homedir(), ".claude.json"),
  opencode: resolve(homedir(), ".config", "opencode", "opencode.json"),
};

const sourcePath = SOURCES[fromArg] ?? resolve(fromArg);

if (!existsSync(sourcePath)) {
  console.error(`Source not found: ${sourcePath}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(sourcePath, "utf-8"));

// ─── Extract mcpServers per format ────────────────────────────────────────

// Cursor / Claude Code: { mcpServers: { name: { command, args, env } } }
// OpenCode:             { mcp:        { name: { command: [...], environment, type } } }

let mcpServers = {};

if (raw.mcpServers) {
  // Cursor / Claude Code — normalize to { command, args, env }
  for (const [name, cfg] of Object.entries(raw.mcpServers)) {
    mcpServers[name] = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
  }
} else if (raw.mcp) {
  // OpenCode — command is a flat array: [executable, ...args]
  for (const [name, cfg] of Object.entries(raw.mcp)) {
    if (cfg.type === "remote" || cfg.url) continue; // skip non-stdio
    const [command, ...cmdArgs] = Array.isArray(cfg.command) ? cfg.command : [cfg.command];
    mcpServers[name] = { command, args: cmdArgs, env: cfg.environment ?? {} };
  }
} else {
  console.error("Unrecognized config format — expected mcpServers or mcp key.");
  process.exit(1);
}

if (Object.keys(mcpServers).length === 0) {
  console.error("No MCP server entries found in source file.");
  process.exit(1);
}

// ─── Secret detection ──────────────────────────────────────────────────────

const SECRET_KEY_RE = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_PASS|_CREDENTIAL|_DSN|_URI|_CERT|_PRIVATE)$/i;
const SECRET_VAL_RE = /^(ATATT|ghp_|gho_|glpat-|sk-|xox[bpoas]-|ey[A-Za-z0-9])/; // known token prefixes
const MIN_SECRET_LEN = 20;

function isSecret(key, value) {
  if (typeof value !== "string") return false;
  if (SECRET_KEY_RE.test(key)) return true;
  if (value.length >= MIN_SECRET_LEN && SECRET_VAL_RE.test(value)) return true;
  return false;
}

// ─── Convert to broker format + extract secrets ────────────────────────────

const SKIP = new Set(["router", "broker", "mcp-broker"]);

const converted   = {};
const skipped     = [];
const secretsToWrite = {}; // VAR_NAME -> value

for (const [name, cfg] of Object.entries(mcpServers)) {
  if (SKIP.has(name)) { skipped.push(name); continue; }

  if (!cfg.command) {
    console.warn(`  ⚠  Skipping "${name}" — no command field`);
    skipped.push(name);
    continue;
  }

  const env = {};
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    if (isSecret(k, v)) {
      secretsToWrite[k] = v;
      env[k] = `\${${k}}`;
    } else {
      env[k] = v;
    }
  }

  converted[name] = {
    description:  `Migrated from ${fromArg}`,
    keywords:     deriveKeywords(name, cfg),
    command:      cfg.command,
    args:         cfg.args ?? [],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    autoActivate: false,
  };
}

// ─── Keyword inference ─────────────────────────────────────────────────────

function deriveKeywords(name, cfg) {
  const words = new Set();
  name.toLowerCase().split(/[-_\s]+/).forEach(w => w.length > 2 && words.add(w));
  const text = [cfg.command, ...(cfg.args ?? [])].join(" ").toLowerCase();
  for (const kw of ["github", "jira", "confluence", "slack", "google", "aws",
                    "mysql", "postgres", "sqlite", "redis", "fetch", "web",
                    "search", "file", "git", "docker", "kubernetes", "eks",
                    "langsmith", "datadog", "linear", "notion", "figma",
                    "linkedin", "atlassian", "pagerduty"]) {
    if (text.includes(kw)) words.add(kw);
  }
  return [...words];
}

// ─── Merge with existing servers.json ─────────────────────────────────────

const outPath = outArg ?? resolve(homedir(), ".config", "mcp-broker", "servers.json");
let existing  = { servers: {} };
if (existsSync(outPath)) {
  existing = JSON.parse(readFileSync(outPath, "utf-8"));
}

const merged  = { servers: { ...existing.servers, ...converted } };
const added   = Object.keys(converted).filter(k => !existing.servers[k]);
const updated = Object.keys(converted).filter(k =>  existing.servers[k]);

// ─── Build .zshenv additions ───────────────────────────────────────────────

const zshenvPath = resolve(homedir(), ".zshenv");
const zshenvExisting = existsSync(zshenvPath) ? readFileSync(zshenvPath, "utf-8") : "";

const newSecrets = Object.entries(secretsToWrite)
  .filter(([k]) => !zshenvExisting.includes(`export ${k}=`));

const zshenvBlock = newSecrets.length > 0
  ? `\n# MCP Broker secrets — migrated from ${fromArg} (${new Date().toISOString().slice(0,10)})\n` +
    newSecrets.map(([k, v]) => `export ${k}="${v}"`).join("\n") + "\n"
  : null;

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\nSource:  ${sourcePath}`);
console.log(`Output:  ${outPath}`);
console.log(`Servers: ${Object.keys(mcpServers).length} found → ${Object.keys(converted).length} converted`);
if (skipped.length)    console.log(`Skipped: ${skipped.join(", ")}`);
if (added.length)      console.log(`Add:     ${added.join(", ")}`);
if (updated.length)    console.log(`Update:  ${updated.join(", ")}`);
if (newSecrets.length) console.log(`Secrets: ${newSecrets.map(([k]) => k).join(", ")} → ~/.zshenv`);
else if (Object.keys(secretsToWrite).length > 0)
                       console.log(`Secrets: all already present in ~/.zshenv`);

if (dryRun) {
  console.log("\n--- servers.json (dry run) ---");
  console.log(JSON.stringify(merged, null, 2));
  if (zshenvBlock) {
    console.log("\n--- ~/.zshenv additions (dry run) ---");
    console.log(zshenvBlock);
  }
  console.log("--- (not written) ---\n");
  process.exit(0);
}

// ─── Write ─────────────────────────────────────────────────────────────────

mkdirSync(resolve(outPath, ".."), { recursive: true });
writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
console.log(`\n✓ Written: ${outPath}`);

if (zshenvBlock) {
  writeFileSync(zshenvPath, zshenvExisting + zshenvBlock);
  console.log(`✓ Written: ${zshenvPath} (${newSecrets.length} secrets added)`);
}

console.log();
