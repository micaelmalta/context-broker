#!/usr/bin/env node
// Reverts a previous `migrate.mjs` run:
//   - Removes entries from ~/.config/mcp-broker/servers.json whose description
//     matches "Migrated from <source>" (the marker migrate.mjs stamps on each entry)
//   - Removes the corresponding secret block from ~/.zshenv
//
// Usage:
//   node scripts/revert-migration.mjs --from cursor
//   node scripts/revert-migration.mjs --from claude
//   node scripts/revert-migration.mjs --from opencode
//   node scripts/revert-migration.mjs --from /path/to/file   (uses the basename as marker)
//   node scripts/revert-migration.mjs --config /custom/servers.json --from cursor
//   node scripts/revert-migration.mjs --from cursor --dry-run

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const fromArg   = get("--from");
const configArg = get("--config");
const dryRun    = has("--dry-run");

if (!fromArg) {
  console.error("Usage: revert-migration.mjs --from <cursor|claude|opencode|/path/to/file> [--config <path>] [--dry-run]");
  process.exit(1);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The migrate script stamps: description: "Migrated from <fromArg>"
// For absolute paths, migrate uses the raw fromArg value as-is.
const migrationLabel = fromArg;
const expectedDescription = `Migrated from ${migrationLabel}`;

// ─── Load servers.json ─────────────────────────────────────────────────────

const serversPath = configArg
  ? resolve(configArg)
  : resolve(homedir(), ".config", "mcp-broker", "servers.json");

if (!existsSync(serversPath)) {
  console.error(`servers.json not found: ${serversPath}`);
  process.exit(1);
}

const serversFile = JSON.parse(readFileSync(serversPath, "utf-8"));
const servers = serversFile.servers ?? {};

// ─── Find entries to remove ────────────────────────────────────────────────

const toRemove = Object.entries(servers)
  .filter(([, cfg]) => cfg.description === expectedDescription)
  .map(([name]) => name);

if (toRemove.length === 0) {
  console.log(`No entries found with description "${expectedDescription}" in ${serversPath}.`);
  console.log("Nothing to revert.");
  process.exit(0);
}

const remaining = Object.fromEntries(
  Object.entries(servers).filter(([name]) => !toRemove.includes(name))
);

// ─── Find zshenv block to remove ──────────────────────────────────────────

const zshenvPath = resolve(homedir(), ".zshenv");
const zshenvContent = existsSync(zshenvPath) ? readFileSync(zshenvPath, "utf-8") : "";

// migrate.mjs writes blocks delimited by:
//   # MCP Broker secrets — migrated from <label> (YYYY-MM-DD)
// followed by export lines, terminated by a blank line or end-of-file.
// We match the header and remove everything up to (but not including) the
// next comment block or the next blank line after the exports.
const blockHeaderRe = new RegExp(
  `\\n# MCP Broker secrets — migrated from ${escapeRe(migrationLabel)} \\(\\d{4}-\\d{2}-\\d{2}\\)\\n` +
  `(?:export [^\\n]+\\n)*`,
  "g"
);

const zshenvReverted = zshenvContent.replace(blockHeaderRe, "\n");
const zshenvChanged  = zshenvReverted !== zshenvContent;

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\nSource label: "${migrationLabel}"`);
console.log(`Config:       ${serversPath}`);
console.log(`\nEntries to remove (${toRemove.length}):`);
for (const name of toRemove) console.log(`  - ${name}`);
console.log(`\nEntries kept (${Object.keys(remaining).length}):`);
for (const name of Object.keys(remaining)) console.log(`  + ${name}`);
if (zshenvChanged) {
  console.log(`\n~/.zshenv: matching secret block will be removed`);
} else {
  console.log(`\n~/.zshenv: no matching secret block found`);
}

if (dryRun) {
  console.log("\n--- servers.json after revert (dry run) ---");
  console.log(JSON.stringify({ servers: remaining }, null, 2));
  if (zshenvChanged) {
    console.log("\n--- ~/.zshenv after revert (dry run) ---");
    console.log(zshenvReverted);
  }
  console.log("--- (not written) ---\n");
  process.exit(0);
}

// ─── Write ─────────────────────────────────────────────────────────────────

writeFileSync(serversPath, JSON.stringify({ servers: remaining }, null, 2) + "\n");
console.log(`\n✓ Written: ${serversPath}`);

if (zshenvChanged) {
  writeFileSync(zshenvPath, zshenvReverted);
  console.log(`✓ Written: ${zshenvPath} (secret block removed)`);
}

console.log();
