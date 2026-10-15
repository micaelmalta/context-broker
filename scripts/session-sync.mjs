#!/usr/bin/env node
// SessionStart sync: keeps skills.json fresh without re-running migrate.
// Runs three passes in order:
//   1. Prune entries whose files no longer exist
//   2. Split any un-split plugin SKILL.md files (body → INSTRUCTIONS.md) and
//      re-sync plugin skills from ~/.claude/plugins/cache/
//   3. Re-sync regular skills from all known skill source directories
//      (claude, cursor, opencode, agents) and ~/.config/context-broker/skills/
// Existing `migratedFrom` / `plugin` markers are preserved so `revert` keeps working.
// Idempotent and safe to run on every session start; it never throws.
//
// Installed by `migrate` to ~/.config/context-broker/scripts/ together with lib/shared.mjs.

import { existsSync, readdirSync, lstatSync } from "fs";
import { resolve, dirname, basename, relative } from "path";
import { homedir } from "os";
import {
  readJsonFile,
  writeJsonSafe,
  findFiles,
  deriveEntry,
  splitSkillMd,
  uniqueSkillKey,
} from "./lib/shared.mjs";

const home = homedir();
const skillsJsonPath = resolve(home, ".config", "context-broker", "skills.json");
const pluginsCache   = resolve(home, ".claude", "plugins", "cache");

// label → directory. Labels double as the `migratedFrom` marker for new entries.
const SKILL_SOURCES = [
  ["claude",   resolve(home, ".claude",  "skills")],
  ["cursor",   resolve(home, ".cursor",  "skills")],
  ["opencode", resolve(home, ".config",  "opencode", "skills")],
  ["agents",   resolve(home, ".agents",  "skills")],
  ["broker",   resolve(home, ".config",  "context-broker", "skills")],
];

const KEEP_FIELDS = ["migratedFrom", "plugin"];
const keepMarkers = (existing) =>
  Object.fromEntries(KEEP_FIELDS.filter((f) => existing?.[f] !== undefined).map((f) => [f, existing[f]]));

function main() {
  if (!existsSync(skillsJsonPath)) return;

  const registry = readJsonFile(skillsJsonPath);
  if (!registry || typeof registry !== "object") return;
  if (!registry.skills) registry.skills = {};
  const skills = registry.skills;

  let split = 0, added = 0, updated = 0, pruned = 0;

  // ─── Pass 1: prune stale entries ──────────────────────────────────────────
  for (const [key, cfg] of Object.entries(skills)) {
    if (cfg.path && !existsSync(cfg.path)) {
      delete skills[key];
      pruned++;
    }
  }

  // ─── Pass 2: plugin skills (split + re-sync) ──────────────────────────────
  if (existsSync(pluginsCache)) {
    for (const skillPath of findFiles(pluginsCache, { name: "SKILL.md", type: "file", maxDepth: 10 })) {
      const skillDir   = dirname(skillPath);
      const skillName  = basename(skillDir);
      const rel        = relative(pluginsCache, skillDir).split("/");
      const pluginName = rel[1] ?? skillName;
      const key        = `${pluginName}:${skillName}`;

      try {
        if (splitSkillMd(skillPath, key)) split++;
        const entry = deriveEntry(key, skillPath, { ...keepMarkers(skills[key]), plugin: pluginName });
        if (skills[key]) updated++; else added++;
        skills[key] = entry;
      } catch (err) {
        process.stderr.write(`[session-sync] skipped ${skillPath}: ${err.message}\n`);
      }
    }
  }

  // ─── Pass 3: regular skill source directories ─────────────────────────────
  const register = (key, skillPath, label) => {
    const k = uniqueSkillKey(skills, key, skillPath, label);
    const prev = skills[k];
    const markers = keepMarkers(prev);
    if (!markers.migratedFrom && !markers.plugin) markers.migratedFrom = label;
    if (prev) updated++; else added++;
    skills[k] = deriveEntry(k, skillPath, markers);
  };

  for (const [label, skillsDir] of SKILL_SOURCES) {
    if (!existsSync(skillsDir)) continue;

    let entries;
    try { entries = readdirSync(skillsDir); } catch { continue; }

    for (const entry of entries) {
      const entryPath = resolve(skillsDir, entry);
      let lstat;
      try { lstat = lstatSync(entryPath); } catch { continue; }
      if (!lstat.isDirectory()) continue;

      try {
        const flatSkill = resolve(entryPath, "SKILL.md");
        if (existsSync(flatSkill)) {
          register(entry, flatSkill, label);
          continue;
        }

        // Namespaced: entry/sub/SKILL.md
        for (const sub of readdirSync(entryPath)) {
          const subDir = resolve(entryPath, sub);
          let subStat;
          try { subStat = lstatSync(subDir); } catch { continue; }
          if (!subStat.isDirectory()) continue;
          const subSkill = resolve(subDir, "SKILL.md");
          if (existsSync(subSkill)) register(`${entry}/${sub}`, subSkill, label);
        }
      } catch (err) {
        process.stderr.write(`[session-sync] skipped ${entryPath}: ${err.message}\n`);
      }
    }
  }

  // ─── Write (atomic; no backup spam on every session) ─────────────────────
  writeJsonSafe(skillsJsonPath, registry, { backup: false });

  if (split > 0 || added > 0 || pruned > 0) {
    process.stderr.write(
      `[session-sync] split=${split} added=${added} updated=${updated} pruned=${pruned}\n`
    );
  }
}

try {
  main();
} catch (err) {
  // A SessionStart hook must never break the session.
  process.stderr.write(`[session-sync] ${err.message}\n`);
}
