#!/usr/bin/env node
// Reverts a previous `migrate.mjs` run:
//   - Removes entries from ~/.config/context-broker/servers.json whose description
//     matches "Migrated from <source>" and restores them to the source config
//   - Removes skill/command entries from skills.json (identified by migratedFrom or plugin)
//     and merges INSTRUCTIONS.md back into SKILL.md in-place
//   - Removes the SessionStart session-sync hook from ~/.claude/settings.json
//
// Usage:
//   node scripts/revert-migration.mjs                        # reverts all sources
//   node scripts/revert-migration.mjs --from cursor          # restrict to one source
//   node scripts/revert-migration.mjs --from claude
//   node scripts/revert-migration.mjs --from opencode
//   node scripts/revert-migration.mjs --from agents
//   node scripts/revert-migration.mjs --from /path/to/file   (uses the basename as marker)
//   node scripts/revert-migration.mjs --config /custom/servers.json
//   node scripts/revert-migration.mjs --skills-config /custom/skills.json
//   node scripts/revert-migration.mjs --plugins
//   node scripts/revert-migration.mjs --dry-run

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve, basename } from "path";
import { execSync } from "child_process";
import { homedir } from "os";

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

const SKILLS_SOURCES = {
  claude:   resolve(homedir(), ".claude", "skills"),
  cursor:   resolve(homedir(), ".cursor", "skills"),
  opencode: resolve(homedir(), ".config", "opencode", "skills"),
  agents:   resolve(homedir(), ".agents", "skills"),
};

function resolveLabels() {
  if (fromArg) return [fromArg];
  return Object.keys({ ...SERVER_SOURCES, ...SKILLS_SOURCES })
    .filter((v, i, a) => a.indexOf(v) === i); // unique
}

// Merge INSTRUCTIONS.md back into SKILL.md at the given SKILL.md path.
function mergeInstructions(skillPath) {
  const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  if (!existsSync(instructionsPath) || !existsSync(skillPath)) return false;
  const stub = readFileSync(skillPath, "utf-8");
  const body = readFileSync(instructionsPath, "utf-8");
  writeFileSync(skillPath, (stub.endsWith("\n") ? stub : stub + "\n") + "\n" + body);
  unlinkSync(instructionsPath);
  return true;
}

// ─── Servers revert ────────────────────────────────────────────────────────

if (revertServers) {
  const serversPath = configArg
    ? resolve(configArg)
    : resolve(homedir(), ".config", "context-broker", "servers.json");

  if (!existsSync(serversPath)) {
    console.log(`\n⚠  servers.json not found: ${serversPath} — skipping servers revert.`);
  } else {
    const allServers = JSON.parse(readFileSync(serversPath, "utf-8")).servers ?? {};

    if (Object.keys(allServers).length === 0) {
      console.log(`\nServers: servers.json is empty — nothing to revert.`);
    } else {
      const labels = resolveLabels();

      for (const label of labels) {
        const sourcePath = SERVER_SOURCES[label] ?? resolve(label);
        const toRestore = Object.entries(allServers)
          .filter(([, cfg]) => cfg.description === `Migrated from ${label}`);

        if (toRestore.length === 0) {
          console.log(`\nServers (${label}): no entries with that migration label — skipping.`);
          continue;
        }

        const mcpServers = {};
        for (const [name, cfg] of toRestore) {
          if (cfg.type === "http" || cfg.url) {
            const entry = { type: "http", url: cfg.url };
            if (cfg.oauth)   entry.oauth   = cfg.oauth;
            if (cfg.headers) entry.headers = cfg.headers;
            if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
            mcpServers[name] = entry;
          } else {
            const entry = { command: cfg.command, args: cfg.args ?? [] };
            if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
            mcpServers[name] = entry;
          }
          delete allServers[name];
        }

        console.log(`\nServers (${label}): restoring ${Object.keys(mcpServers).length} entries to ${sourcePath}`);

        if (dryRun) {
          console.log(JSON.stringify({ mcpServers }, null, 2));
        } else {
          const sourceRaw = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf-8")) : {};
          sourceRaw.mcpServers = { ...(sourceRaw.mcpServers ?? {}), ...mcpServers };
          writeFileSync(sourcePath, JSON.stringify(sourceRaw, null, 2) + "\n");
          console.log(`✓ Written: ${sourcePath}`);

          // Re-enable plugins that were disabled during migration
          const settingsPath = resolve(homedir(), ".claude", "settings.json");
          if (existsSync(settingsPath)) {
            const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
            const plugins = settings.enabledPlugins ?? {};
            const httpNames = new Set(
              Object.entries(mcpServers)
                .filter(([, cfg]) => cfg.type === "http" || cfg.url)
                .map(([name]) => name)
            );
            let enabledCount = 0;
            for (const pluginKey of Object.keys(plugins)) {
              const pluginName = pluginKey.split("@")[0];
              if (httpNames.has(pluginName) && plugins[pluginKey] === false) {
                plugins[pluginKey] = true;
                enabledCount++;
              }
            }
            if (enabledCount > 0) {
              writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
              console.log(`✓ Re-enabled ${enabledCount} plugin(s) in ${settingsPath}`);
            }
          }
        }
      }

      if (!dryRun) {
        const serversFile = JSON.parse(readFileSync(serversPath, "utf-8"));
        serversFile.servers = allServers;
        writeFileSync(serversPath, JSON.stringify(serversFile, null, 2) + "\n");
        console.log(`✓ Updated: ${serversPath}`);
      } else {
        console.log("\n--- servers.json after revert (dry run) ---");
        console.log(JSON.stringify({ servers: allServers }, null, 2));
        console.log("--- (not written) ---");
      }
    }
  }

  // ─── Remove context-broker router from ~/.claude.json ───────────────────
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    if (dryRun) {
      console.log(`\n--- ~/.claude.json broker removal (dry run) ---`);
      console.log(`  Would remove "context-broker" from mcpServers`);
      console.log("--- (not written) ---");
    } else {
      const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      if (claudeJson.mcpServers?.["context-broker"]) {
        delete claudeJson.mcpServers["context-broker"];
        writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n");
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
    const skillsFile = JSON.parse(readFileSync(skillsPath, "utf-8"));
    const skills = skillsFile.skills ?? {};
    const labels = resolveLabels();
    let anyFound = false;

    for (const label of labels) {
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
      writeFileSync(skillsPath, JSON.stringify({ skills }, null, 2) + "\n");
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
    const skillsFile = JSON.parse(readFileSync(skillsPath, "utf-8"));
    const skills = skillsFile.skills ?? {};

    const pluginEntries = Object.entries(skills).filter(([, cfg]) => cfg.plugin);

    // Always scan for INSTRUCTIONS.md files — registry may be out of sync with file state
    let instructionsFiles = [];
    try {
      instructionsFiles = execSync(`find "${pluginsCache}" -name "INSTRUCTIONS.md"`, { encoding: "utf-8" })
        .trim().split("\n").filter(Boolean);
    } catch { /* no cache */ }

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
        writeFileSync(skillsPath, JSON.stringify({ skills: remaining }, null, 2) + "\n");
        if (restored > 0) console.log(`✓ Restored ${restored} SKILL.md files`);
        if (pluginEntries.length > 0) console.log(`✓ Removed ${pluginEntries.length} plugin entries from ${skillsPath}`);

        // Remove the SessionStart session-sync hook
        const settingsPath = resolve(homedir(), ".claude", "settings.json");
        if (existsSync(settingsPath)) {
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
          const hooks = settings.hooks?.SessionStart ?? [];
          const filtered = hooks.filter(entry =>
            !entry.hooks?.some(h => h.command?.includes("session-sync.mjs") || h.command?.includes("split-skills.mjs"))
          );
          if (filtered.length !== hooks.length) {
            settings.hooks.SessionStart = filtered;
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
            console.log(`✓ Removed session-sync SessionStart hook from ${settingsPath}`);
          }
        }
      }
    }
  }
}

console.log();
