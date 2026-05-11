#!/usr/bin/env node
// Reverts a previous `migrate.mjs` run:
//   - Removes entries from ~/.config/context-broker/servers.json whose description
//     matches "Migrated from <source>" (the marker migrate.mjs stamps on each entry)
//   - Removes entries from ~/.config/context-broker/skills.json whose migratedFrom
//     field matches a known source, and moves skill dirs back with INSTRUCTIONS.md merged
//   - With --plugins, removes all plugin entries from skills.json and restores
//     SKILL.md files from their INSTRUCTIONS.md sibling
//   - Removes the corresponding secret block from ~/.zshenv
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

import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, lstatSync } from "fs";
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

if (revertSkills) {
  const skillsPath = skillsConfigArg
    ? resolve(skillsConfigArg)
    : resolve(homedir(), ".config", "context-broker", "skills.json");

  if (!existsSync(skillsPath)) {
    console.log(`\n⚠  skills.json not found: ${skillsPath} — skipping skills revert.`);
  } else {
    const skillsFile = JSON.parse(readFileSync(skillsPath, "utf-8"));
    const skills = skillsFile.skills ?? {};
    const brokerSkillsDir = resolve(homedir(), ".config", "context-broker", "skills");
    const labels = resolveLabels();

    let anyFound = false;

    for (const label of labels) {
      const skillsDir = SKILLS_SOURCES[label] ?? resolve(label, "skills");
      const skillsToRemove = Object.entries(skills)
        .filter(([, cfg]) => cfg.migratedFrom === label)
        .map(([name]) => name);

      if (skillsToRemove.length === 0) continue;
      anyFound = true;

      console.log(`\nSkills (${label}): removing ${skillsToRemove.length} entries, restoring to ${skillsDir}`);

      // Group by the top-level broker dir to move (namespace dirs move as a unit)
      // name may be "skill" (flat) or "namespace/skill" (nested)
      const brokerDirsToMove = new Map(); // brokerTopDir -> srcTopDir
      for (const name of skillsToRemove) {
        const parts = name.split("/");
        const topLevel = parts[0];
        brokerDirsToMove.set(resolve(brokerSkillsDir, topLevel), resolve(skillsDir, topLevel));
      }

      if (dryRun) {
        for (const name of skillsToRemove) {
          const skillDir = resolve(brokerSkillsDir, ...name.split("/"));
          const instructionsPath = resolve(skillDir, "INSTRUCTIONS.md");
          console.log(`  ${name}: ${existsSync(instructionsPath) ? "merge INSTRUCTIONS.md → SKILL.md, " : ""}move to ${skillsDir}/${name.split("/")[0]}`);
        }
        for (const [brokerTop, srcTop] of brokerDirsToMove) {
          let symlinkNote = "";
          try { if (lstatSync(srcTop).isSymbolicLink()) symlinkNote = " (remove symlink)"; } catch {}
          console.log(`  move ${brokerTop} → ${srcTop}${symlinkNote}`);
        }
      } else {
        // First merge all INSTRUCTIONS.md back into SKILL.md
        let mergedCount = 0;
        for (const name of skillsToRemove) {
          const skillDir = resolve(brokerSkillsDir, ...name.split("/"));
          const instructionsPath = resolve(skillDir, "INSTRUCTIONS.md");
          const skillMdPath = resolve(skillDir, "SKILL.md");
          if (existsSync(instructionsPath) && existsSync(skillMdPath)) {
            const stub = readFileSync(skillMdPath, "utf-8");
            const body = readFileSync(instructionsPath, "utf-8");
            writeFileSync(skillMdPath, (stub.endsWith("\n") ? stub : stub + "\n") + "\n" + body);
            unlinkSync(instructionsPath);
            mergedCount++;
          }
          delete skills[name];
        }

        // Then move each top-level broker dir back (once per namespace/skill)
        let movedCount = 0;
        for (const [brokerTop, srcTop] of brokerDirsToMove) {
          try { if (lstatSync(srcTop).isSymbolicLink()) unlinkSync(srcTop); } catch {}
          if (existsSync(brokerTop)) {
            renameSync(brokerTop, srcTop);
            movedCount++;
          }
        }
        console.log(`✓ Merged INSTRUCTIONS.md into SKILL.md for ${mergedCount} skill(s)`);
        console.log(`✓ Moved ${movedCount} dir(s) back to ${skillsDir}`);
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
        console.log(`  Would remove split-skills SessionStart hook from ~/.claude/settings.json`);
      } else {
        // Restore SKILL.md: merge frontmatter stub with body from INSTRUCTIONS.md
        let restored = 0;
        for (const instructionsPath of instructionsFiles) {
          const skillPath = instructionsPath.replace(/INSTRUCTIONS\.md$/, "SKILL.md");
          if (!existsSync(skillPath)) continue;
          const stub = readFileSync(skillPath, "utf-8");
          const body = readFileSync(instructionsPath, "utf-8");
          const stubNormalized = stub.endsWith("\n") ? stub : stub + "\n";
          writeFileSync(skillPath, stubNormalized + "\n" + body);
          unlinkSync(instructionsPath);
          restored++;
        }

        // Remove plugin entries from skills.json
        const remaining = Object.fromEntries(
          Object.entries(skills).filter(([, cfg]) => !cfg.plugin)
        );
        writeFileSync(skillsPath, JSON.stringify({ skills: remaining }, null, 2) + "\n");
        if (restored > 0) console.log(`✓ Restored ${restored} SKILL.md files`);
        if (pluginEntries.length > 0) console.log(`✓ Removed ${pluginEntries.length} plugin entries from ${skillsPath}`);

        // Remove the SessionStart session-sync hook from ~/.claude/settings.json
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
