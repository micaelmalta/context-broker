#!/usr/bin/env node
// Reverts a previous `migrate.mjs` run:
//   - Removes entries from ~/.config/context-broker/servers.json that `migrate` created
//     (identified by `migratedFrom`, or the legacy "Migrated from <source>" description)
//     and restores them to the source config in that client's own format
//   - Re-enables exactly the plugins that `migrate` disabled
//   - Removes skill/command entries from skills.json (identified by migratedFrom or plugin)
//     and merges INSTRUCTIONS.md back into SKILL.md in-place
//   - Removes the SessionStart session-sync hook from ~/.claude/settings.json
//   - Removes the context-broker entry that migrate added to a restored client's config
//     (Cursor, OpenCode), and from ~/.claude.json only once no migrated servers remain
// Every modified config file is backed up first (<file>.bak-<timestamp>).
//
// Note: secrets that `migrate` extracted into your shell config file are left in
// place (other tools may rely on them); remove them manually if you no longer need them.
//
// Usage:
//   node scripts/revert-migration.mjs                        # reverts all sources
//   node scripts/revert-migration.mjs --from cursor          # restrict to one source
//   node scripts/revert-migration.mjs --from claude
//   node scripts/revert-migration.mjs --from opencode
//   node scripts/revert-migration.mjs --from agents
//   node scripts/revert-migration.mjs --from plugin          # servers that came from plugins
//   node scripts/revert-migration.mjs --from /path/to/file   (uses the basename as marker)
//   node scripts/revert-migration.mjs --config /custom/servers.json
//   node scripts/revert-migration.mjs --skills-config /custom/skills.json
//   node scripts/revert-migration.mjs --plugins
//   node scripts/revert-migration.mjs --dry-run

import { existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import { homedir } from "os";
import {
  readJsonFile,
  writeJsonSafe,
  findFiles,
  mergeInstructions,
  toCursorVars,
  mapStrings,
} from "./lib/shared.mjs";

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const fromArg         = get("--from");
const configArg       = get("--config");
const skillsConfigArg = get("--skills-config");
const dryRun          = has("--dry-run");
const explicitSkills  = has("--skills");
const explicitPlugins = has("--plugins");
const revertServers   = !explicitSkills && !explicitPlugins || has("--servers");
const revertSkills    = explicitSkills  || (!explicitPlugins && !has("--servers"));
const revertPlugins   = explicitPlugins || (!explicitSkills  && !has("--servers"));

// ─── Source registries ─────────────────────────────────────────────────────

const SERVER_SOURCES = {
  cursor:   resolve(homedir(), ".cursor", "mcp.json"),
  claude:   resolve(homedir(), ".claude.json"),
  opencode: resolve(homedir(), ".config", "opencode", "opencode.json"),
};

// Labels that can appear in `migratedFrom` (session-sync labels its own dir "broker").
const ALL_LABELS = ["cursor", "claude", "opencode", "agents", "plugin", "broker"];

function resolveLabels() {
  if (fromArg) return [fromArg];
  return ALL_LABELS;
}

const settingsPath = resolve(homedir(), ".claude", "settings.json");
const claudeJsonPath = resolve(homedir(), ".claude.json");

// Write one server back in the format its source client uses.
function toSourceFormat(label, sourcePath, cfg) {
  const isOpenCode = label === "opencode" || basename(sourcePath) === "opencode.json";
  const isCursor = label === "cursor" || basename(dirname(sourcePath)) === ".cursor";
  const fix = isCursor ? (v) => mapStrings(v, toCursorVars) : (v) => v;
  const isHttp = cfg.type === "http" || cfg.url;
  const hasEnv = cfg.env && Object.keys(cfg.env).length > 0;

  if (isOpenCode) {
    if (isHttp) {
      const e = { type: "remote", url: cfg.url };
      if (cfg.oauth)   e.oauth = cfg.oauth;
      if (cfg.headers) e.headers = cfg.headers;
      if (hasEnv)      e.environment = cfg.env;
      return { key: "mcp", entry: e };
    }
    const e = { type: "local", command: [cfg.command, ...(cfg.args ?? [])] };
    if (hasEnv) e.environment = cfg.env;
    return { key: "mcp", entry: e };
  }

  if (isHttp) {
    const e = { type: "http", url: fix(cfg.url) };
    if (cfg.oauth)   e.oauth = cfg.oauth;
    if (cfg.headers) e.headers = fix(cfg.headers);
    if (hasEnv)      e.env = fix(cfg.env);
    return { key: "mcpServers", entry: e };
  }
  const e = { command: fix(cfg.command), args: fix(cfg.args ?? []) };
  if (hasEnv) e.env = fix(cfg.env);
  return { key: "mcpServers", entry: e };
}

// ─── Servers revert ────────────────────────────────────────────────────────

if (revertServers) {
  const serversPath = configArg
    ? resolve(configArg)
    : resolve(homedir(), ".config", "context-broker", "servers.json");

  let remainingCount = null; // unknown until servers.json is read

  if (!existsSync(serversPath)) {
    console.log(`\n⚠  servers.json not found: ${serversPath} — skipping servers revert.`);
    remainingCount = 0;
  } else {
    const serversFile = readJsonFile(serversPath);
    const allServers = serversFile.servers ?? {};

    if (Object.keys(allServers).length === 0) {
      console.log(`\nServers: servers.json is empty — nothing to revert.`);
      remainingCount = 0;
    } else {
      const settings = readJsonFile(settingsPath, null);
      const pluginsToEnable = new Set();

      for (const label of resolveLabels()) {
        const sourcePath = SERVER_SOURCES[label] ?? resolve(label);
        const toRestore = Object.entries(allServers).filter(
          ([, cfg]) => cfg.migratedFrom === label || cfg.description === `Migrated from ${label}`
        );

        if (toRestore.length === 0) {
          if (fromArg) console.log(`\nServers (${label}): no entries with that migration label — skipping.`);
          continue;
        }

        const restoredByKey = {};
        for (const [name, cfg] of toRestore) {
          // Plugin-shipped servers have no config file of their own — re-enabling the plugin restores them.
          if (label !== "plugin") {
            const { key, entry } = toSourceFormat(label, sourcePath, cfg);
            (restoredByKey[key] ??= {})[name] = entry;
          }

          // Re-enable exactly the plugins migrate disabled (legacy entries: HTTP servers by name).
          if (cfg.disabledPlugins) {
            cfg.disabledPlugins.forEach((k) => pluginsToEnable.add(k));
          } else if (cfg.description === `Migrated from ${label}` && (cfg.type === "http" || cfg.url)) {
            for (const pluginKey of Object.keys(settings?.enabledPlugins ?? {})) {
              if (pluginKey.split("@")[0] === name) pluginsToEnable.add(pluginKey);
            }
          }
          delete allServers[name];
        }

        if (label === "plugin") {
          console.log(`\nServers (plugin): removing ${toRestore.length} plugin-provided entries (plugins re-enabled below)`);
        } else {
          console.log(`\nServers (${label}): restoring ${toRestore.length} entries to ${sourcePath}`);
          if (dryRun) {
            console.log(JSON.stringify(restoredByKey, null, 2));
          } else {
            const sourceRaw = readJsonFile(sourcePath, {});
            for (const [key, entries] of Object.entries(restoredByKey)) {
              sourceRaw[key] = { ...(sourceRaw[key] ?? {}), ...entries };
            }
            // This client's servers are back, so it no longer needs the broker
            // (~/.claude.json is handled separately below).
            if (resolve(sourcePath) !== claudeJsonPath) {
              for (const key of ["mcpServers", "mcp"]) {
                if (sourceRaw[key]?.["context-broker"]) {
                  delete sourceRaw[key]["context-broker"];
                  console.log(`✓ Removed context-broker from ${sourcePath}`);
                }
              }
            }
            writeJsonSafe(sourcePath, sourceRaw);
            console.log(`✓ Written: ${sourcePath}`);
          }
        }
      }

      if (settings && pluginsToEnable.size > 0) {
        const plugins = settings.enabledPlugins ?? {};
        const enabling = [...pluginsToEnable].filter((k) => plugins[k] === false);
        if (enabling.length > 0) {
          if (dryRun) {
            console.log(`  Would re-enable ${enabling.length} plugin(s) in ${settingsPath}`);
          } else {
            enabling.forEach((k) => { plugins[k] = true; });
            writeJsonSafe(settingsPath, settings);
            console.log(`✓ Re-enabled ${enabling.length} plugin(s) in ${settingsPath}`);
          }
        }
      }

      remainingCount = Object.keys(allServers).length;
      if (!dryRun) {
        serversFile.servers = allServers;
        writeJsonSafe(serversPath, serversFile);
        console.log(`✓ Updated: ${serversPath}`);
      } else {
        console.log("\n--- servers.json after revert (dry run) ---");
        console.log(JSON.stringify({ servers: allServers }, null, 2));
        console.log("--- (not written) ---");
      }
    }
  }

  // ─── Remove context-broker router from ~/.claude.json ───────────────────
  // Only once nothing migrated is left behind it — otherwise the remaining
  // servers would become unreachable.
  if (existsSync(claudeJsonPath)) {
    if (remainingCount !== 0) {
      console.log(`\n  Keeping context-broker in ${claudeJsonPath} — ${remainingCount ?? "some"} server(s) still managed by the broker`);
    } else if (dryRun) {
      console.log(`\n--- ~/.claude.json broker removal (dry run) ---`);
      console.log(`  Would remove "context-broker" from mcpServers`);
      console.log("--- (not written) ---");
    } else {
      const claudeJson = readJsonFile(claudeJsonPath, {});
      if (claudeJson.mcpServers?.["context-broker"]) {
        delete claudeJson.mcpServers["context-broker"];
        writeJsonSafe(claudeJsonPath, claudeJson);
        console.log(`✓ Removed context-broker from ${claudeJsonPath}`);
      } else {
        console.log(`  context-broker not found in ${claudeJsonPath} — skipped`);
      }
    }
  }
}

// ─── Skills revert ─────────────────────────────────────────────────────────
// Skills and commands were registered in-place, so revert just removes registry
// entries and merges INSTRUCTIONS.md back into SKILL.md where applicable.

if (revertSkills) {
  const skillsPath = skillsConfigArg
    ? resolve(skillsConfigArg)
    : resolve(homedir(), ".config", "context-broker", "skills.json");

  if (!existsSync(skillsPath)) {
    console.log(`\n⚠  skills.json not found: ${skillsPath} — skipping skills revert.`);
  } else {
    const skills = readJsonFile(skillsPath).skills ?? {};
    let anyFound = false;

    for (const label of resolveLabels()) {
      const toRemove = Object.entries(skills)
        .filter(([, cfg]) => cfg.migratedFrom === label)
        .map(([name]) => name);

      if (toRemove.length === 0) continue;
      anyFound = true;

      console.log(`\nSkills (${label}): removing ${toRemove.length} entries`);

      if (dryRun) {
        for (const name of toRemove) {
          const cfg = skills[name];
          const isSkill = cfg.path?.endsWith("SKILL.md");
          const instructionsPath = isSkill ? cfg.path.replace(/SKILL\.md$/, "INSTRUCTIONS.md") : null;
          const mergeNote = instructionsPath && existsSync(instructionsPath) ? " (merge INSTRUCTIONS.md → SKILL.md)" : "";
          console.log(`  ${name}${mergeNote}`);
        }
      } else {
        let mergedCount = 0;
        for (const name of toRemove) {
          const cfg = skills[name];
          if (cfg.path?.endsWith("SKILL.md") && mergeInstructions(cfg.path)) mergedCount++;
          delete skills[name];
        }
        if (mergedCount > 0) console.log(`✓ Merged INSTRUCTIONS.md into SKILL.md for ${mergedCount} skill(s)`);
      }
    }

    if (!anyFound) {
      console.log(`\nSkills: no entries with a known migratedFrom label — nothing to revert.`);
    } else if (!dryRun) {
      writeJsonSafe(skillsPath, { skills });
      console.log(`✓ Written: ${skillsPath}`);
    } else {
      console.log("\n--- skills.json after revert (dry run) ---");
      console.log(JSON.stringify({ skills }, null, 2));
      console.log("--- (not written) ---");
    }
  }
}

// ─── Plugins revert ────────────────────────────────────────────────────────
// Plugin files stay in ~/.claude/plugins/cache — revert merges INSTRUCTIONS.md
// back into SKILL.md in-place and removes plugin entries from skills.json.

if (revertPlugins) {
  const skillsPath = skillsConfigArg
    ? resolve(skillsConfigArg)
    : resolve(homedir(), ".config", "context-broker", "skills.json");

  const pluginsCache = resolve(homedir(), ".claude", "plugins", "cache");

  if (!existsSync(skillsPath)) {
    console.log(`\n⚠  skills.json not found: ${skillsPath} — skipping plugins revert.`);
  } else {
    const skills = readJsonFile(skillsPath).skills ?? {};
    const pluginEntries = Object.entries(skills).filter(([, cfg]) => cfg.plugin);

    // Always scan for INSTRUCTIONS.md files — registry may be out of sync with file state
    const instructionsFiles = existsSync(pluginsCache)
      ? findFiles(pluginsCache, { name: "INSTRUCTIONS.md", type: "file", maxDepth: 10 })
      : [];

    if (pluginEntries.length === 0 && instructionsFiles.length === 0) {
      console.log(`\nPlugins: no plugin entries in skills.json and no INSTRUCTIONS.md files found — nothing to revert.`);
    } else {
      if (pluginEntries.length > 0) console.log(`\nPlugin registry entries to remove: ${pluginEntries.length}`);
      if (instructionsFiles.length > 0) console.log(`Plugin SKILL.md files to restore: ${instructionsFiles.length}`);

      if (dryRun) {
        if (pluginEntries.length > 0) console.log(`  Would remove ${pluginEntries.length} entries from skills.json`);
        if (instructionsFiles.length > 0) console.log(`  Would restore ${instructionsFiles.length} SKILL.md files from INSTRUCTIONS.md`);
        console.log(`  Would remove session-sync SessionStart hook from ~/.claude/settings.json`);
      } else {
        let restored = 0;
        for (const instructionsPath of instructionsFiles) {
          const skillPath = instructionsPath.replace(/INSTRUCTIONS\.md$/, "SKILL.md");
          if (mergeInstructions(skillPath)) restored++;
        }

        const remaining = Object.fromEntries(
          Object.entries(skills).filter(([, cfg]) => !cfg.plugin)
        );
        writeJsonSafe(skillsPath, { skills: remaining });
        if (restored > 0) console.log(`✓ Restored ${restored} SKILL.md files`);
        if (pluginEntries.length > 0) console.log(`✓ Removed ${pluginEntries.length} plugin entries from ${skillsPath}`);

        // Remove the SessionStart session-sync hook (also the legacy split-skills one)
        const settings = readJsonFile(settingsPath, null);
        if (settings) {
          const hooks = settings.hooks?.SessionStart ?? [];
          const filtered = hooks.filter(entry =>
            !entry.hooks?.some(h => h.command?.includes("session-sync.mjs") || h.command?.includes("split-skills.mjs"))
          );
          if (filtered.length !== hooks.length) {
            settings.hooks.SessionStart = filtered;
            writeJsonSafe(settingsPath, settings);
            console.log(`✓ Removed session-sync SessionStart hook from ${settingsPath}`);
          }
        }
      }
    }
  }
}

console.log();
