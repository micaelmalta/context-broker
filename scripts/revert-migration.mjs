#!/usr/bin/env node
// Reverts a previous `migrate.mjs` run:
//   - Removes entries from ~/.config/context-broker/servers.json whose description
//     matches "Migrated from <source>" (the marker migrate.mjs stamps on each entry)
//   - With --skills, also removes entries from ~/.config/context-broker/skills.json
//     whose migratedFrom field matches <source>
//   - With --plugins, removes all plugin entries from skills.json and restores
//     SKILL.md files from their INSTRUCTIONS.md sibling
//   - Removes the corresponding secret block from ~/.zshenv
//
// Usage:
//   node scripts/revert-migration.mjs --from cursor
//   node scripts/revert-migration.mjs --from claude
//   node scripts/revert-migration.mjs --from opencode
//   node scripts/revert-migration.mjs --from /path/to/file   (uses the basename as marker)
//   node scripts/revert-migration.mjs --config /custom/servers.json --from cursor
//   node scripts/revert-migration.mjs --from claude --skills
//   node scripts/revert-migration.mjs --from claude --skills --skills-config /custom/skills.json
//   node scripts/revert-migration.mjs --from claude --plugins
//   node scripts/revert-migration.mjs --from cursor --dry-run

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

if (!fromArg) {
  console.error("Usage: revert-migration.mjs --from <cursor|claude|opencode|/path/to/file> [--config <path>] [--dry-run]");
  process.exit(1);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const migrationLabel = fromArg;

console.log(`\nSource label: "${migrationLabel}"`);

// ─── Servers revert ────────────────────────────────────────────────────────

if (revertServers) {
  const SOURCES = {
    cursor:   resolve(homedir(), ".cursor", "mcp.json"),
    claude:   resolve(homedir(), ".claude.json"),
    opencode: resolve(homedir(), ".config", "opencode", "opencode.json"),
  };
  const sourcePath = SOURCES[migrationLabel] ?? resolve(migrationLabel);

  const serversPath = configArg
    ? resolve(configArg)
    : resolve(homedir(), ".config", "context-broker", "servers.json");

  if (!existsSync(serversPath)) {
    console.log(`\n⚠  servers.json not found: ${serversPath} — skipping servers revert.`);
  } else {
    const servers = JSON.parse(readFileSync(serversPath, "utf-8")).servers ?? {};

    if (Object.keys(servers).length === 0) {
      console.log(`\nServers: servers.json is empty — nothing to revert.`);
    } else {
      // Reconstruct mcpServers entries from servers.json
      const mcpServers = {};
      for (const [name, cfg] of Object.entries(servers)) {
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
      }

      console.log(`\nServers to restore to ${sourcePath} (${Object.keys(mcpServers).length}): ${Object.keys(mcpServers).join(", ")}`);

      if (dryRun) {
        console.log("\n--- mcpServers to add (dry run) ---");
        console.log(JSON.stringify({ mcpServers }, null, 2));
        console.log("--- (not written) ---");
      } else {
        const sourceRaw = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf-8")) : {};
        sourceRaw.mcpServers = { ...(sourceRaw.mcpServers ?? {}), ...mcpServers };
        writeFileSync(sourcePath, JSON.stringify(sourceRaw, null, 2) + "\n");
        console.log(`\n✓ Written: ${sourcePath}`);

        // Re-enable plugins that were disabled during migration
        const settingsPath = resolve(homedir(), ".claude", "settings.json");
        if (existsSync(settingsPath)) {
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
          const plugins = settings.enabledPlugins ?? {};
          const httpNames = new Set(
            Object.entries(servers)
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

    const skillsToRemove = Object.entries(skills)
      .filter(([, cfg]) => cfg.migratedFrom === migrationLabel)
      .map(([name]) => name);

    if (skillsToRemove.length === 0) {
      console.log(`\nSkills: no entries with migratedFrom "${migrationLabel}" found — nothing to revert.`);
    } else {
      const remainingSkills = Object.fromEntries(
        Object.entries(skills).filter(([name]) => !skillsToRemove.includes(name))
      );

      console.log(`\nSkill entries to remove (${skillsToRemove.length}): ${skillsToRemove.join(", ")}`);

      const SKILLS_SOURCES = {
        claude:   resolve(homedir(), ".claude", "skills"),
        cursor:   resolve(homedir(), ".cursor", "skills"),
        opencode: resolve(homedir(), ".config", "opencode", "skills"),
      };
      const skillsDir = SKILLS_SOURCES[migrationLabel] ?? resolve(migrationLabel, "skills");
      const brokerSkillsDir = resolve(homedir(), ".config", "context-broker", "skills");

      if (dryRun) {
        for (const name of skillsToRemove) {
          const brokerDir = resolve(brokerSkillsDir, name);
          const instructionsPath = resolve(brokerDir, "INSTRUCTIONS.md");
          const symlink = resolve(skillsDir, name);
          const isSymlink = existsSync(symlink) && lstatSync(symlink).isSymbolicLink();
          console.log(`  ${name}: merge INSTRUCTIONS.md → SKILL.md, move ${brokerDir} → ${skillsDir}/${name}${isSymlink ? " (remove symlink)" : ""}`);
        }
        console.log("\n--- skills.json after revert (dry run) ---");
        console.log(JSON.stringify({ skills: remainingSkills }, null, 2));
        console.log("--- (not written) ---");
      } else {
        let mergedCount = 0, movedCount = 0;
        for (const name of skillsToRemove) {
          const brokerDir = resolve(brokerSkillsDir, name);
          const instructionsPath = resolve(brokerDir, "INSTRUCTIONS.md");
          const skillMdPath = resolve(brokerDir, "SKILL.md");
          const symlinkPath = resolve(skillsDir, name);

          // Merge INSTRUCTIONS.md back into SKILL.md
          if (existsSync(instructionsPath) && existsSync(skillMdPath)) {
            const stub = readFileSync(skillMdPath, "utf-8");
            const body = readFileSync(instructionsPath, "utf-8");
            const stubNormalized = stub.endsWith("\n") ? stub : stub + "\n";
            writeFileSync(skillMdPath, stubNormalized + "\n" + body);
            unlinkSync(instructionsPath);
            mergedCount++;
          }

          // Remove symlink and move broker dir back to source
          if (existsSync(symlinkPath) && lstatSync(symlinkPath).isSymbolicLink()) {
            unlinkSync(symlinkPath);
          }
          if (existsSync(brokerDir)) {
            renameSync(brokerDir, resolve(skillsDir, name));
            movedCount++;
          }
        }
        writeFileSync(skillsPath, JSON.stringify({ skills: remainingSkills }, null, 2) + "\n");
        console.log(`✓ Merged INSTRUCTIONS.md into SKILL.md for ${mergedCount} skill(s)`);
        console.log(`✓ Moved ${movedCount} skill(s) back to ${skillsDir}`);
        console.log(`✓ Written: ${skillsPath}`);
      }
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

        // Remove the SessionStart split-skills hook from ~/.claude/settings.json
        const settingsPath = resolve(homedir(), ".claude", "settings.json");
        if (existsSync(settingsPath)) {
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
          const hooks = settings.hooks?.SessionStart ?? [];
          const filtered = hooks.filter(entry =>
            !entry.hooks?.some(h => h.command?.includes("split-skills.mjs"))
          );
          if (filtered.length !== hooks.length) {
            settings.hooks.SessionStart = filtered;
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
            console.log(`✓ Removed split-skills SessionStart hook from ${settingsPath}`);
          }
        }
      }
    }
  }
}

console.log();
