#!/usr/bin/env node
// SessionStart sync: keeps skills.json fresh without re-running migrate.
// Runs three passes in order:
//   1. Split any un-split plugin SKILL.md files (body → INSTRUCTIONS.md)
//   2. Re-sync plugin skills from ~/.claude/plugins/cache/
//   3. Re-sync regular skills from all known skill source directories
//      (claude, cursor, opencode, agents) and ~/.config/context-broker/skills/
// Stale entries whose paths no longer exist are pruned automatically.
// Idempotent — safe to run on every session start.

import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "fs";
import { resolve, dirname, basename, relative } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const home = homedir();
const skillsJsonPath = resolve(home, ".config", "context-broker", "skills.json");
const pluginsCache   = resolve(home, ".claude", "plugins", "cache");

const SKILL_SOURCES = [
  resolve(home, ".claude",  "skills"),
  resolve(home, ".cursor",  "skills"),
  resolve(home, ".config",  "opencode", "skills"),
  resolve(home, ".agents",  "skills"),
  resolve(home, ".config",  "context-broker", "skills"),
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const result = {};
  let key = null, multi = [];
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)/);
    if (kv) {
      if (key && multi.length) result[key] = multi.join(" ").trim();
      key = kv[1]; const val = kv[2].trim();
      if (val && val !== ">") { result[key] = val; key = null; }
      multi = [];
    } else if (key && line.startsWith("  ")) {
      multi.push(line.trim());
    }
  }
  if (key && multi.length) result[key] = multi.join(" ").trim();
  return result;
}

function deriveEntry(key, skillPath, extra = {}) {
  const content = readFileSync(skillPath, "utf-8");
  const fm = parseFrontmatter(content);
  const firstLine = content.split("\n").find(l => /^[A-Z]/.test(l)) ?? "";
  const description = fm.description ?? (firstLine.slice(0, 120) || `Skill: ${key}`);
  const words = new Set();
  key.toLowerCase().split(/[-_:/\s]+/).filter(w => w.length > 2).forEach(w => words.add(w));
  description.toLowerCase().split(/\W+/).filter(w => w.length > 4).slice(0, 8).forEach(w => words.add(w));
  return { description, keywords: [...words].slice(0, 12), path: skillPath, ...extra };
}

// ─── Load registry ────────────────────────────────────────────────────────────

if (!existsSync(skillsJsonPath)) process.exit(0);
const registry = JSON.parse(readFileSync(skillsJsonPath, "utf-8"));
if (!registry.skills) registry.skills = {};

let split = 0, added = 0, updated = 0, pruned = 0;

// ─── Pass 1: prune stale entries ──────────────────────────────────────────────

for (const [key, cfg] of Object.entries(registry.skills)) {
  if (cfg.path && !existsSync(cfg.path)) {
    delete registry.skills[key];
    pruned++;
  }
}

// ─── Pass 2: plugin skills (split + re-sync) ──────────────────────────────────

if (existsSync(pluginsCache)) {
  let skillFiles = [];
  try {
    skillFiles = execSync(`find "${pluginsCache}" -name "SKILL.md"`, { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
  } catch { /* plugins cache empty */ }

  for (const skillPath of skillFiles) {
    const skillDir  = dirname(skillPath);
    const skillName = basename(skillDir);
    const rel        = relative(pluginsCache, skillDir).split("/");
    const pluginName = rel[1] ?? skillName;
    const key        = `${pluginName}:${skillName}`;
    const instrPath  = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");

    // Split if body not yet extracted
    if (!existsSync(instrPath)) {
      const content = readFileSync(skillPath, "utf-8");
      const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
      if (match) {
        const body = match[2].replace(/^\n+/, "");
        if (body) {
          writeFileSync(skillPath, match[1]);
          writeFileSync(instrPath, body);
          split++;
        }
      }
    }

    const entry = deriveEntry(key, skillPath, { plugin: pluginName });
    if (registry.skills[key]) updated++; else added++;
    registry.skills[key] = entry;
  }
}

// ─── Pass 3: regular skill source directories ─────────────────────────────────

for (const skillsDir of SKILL_SOURCES) {
  if (!existsSync(skillsDir)) continue;

  let entries;
  try { entries = readdirSync(skillsDir); } catch { continue; }

  for (const entry of entries) {
    const entryPath = resolve(skillsDir, entry);
    let lstat;
    try { lstat = lstatSync(entryPath); } catch { continue; }
    if (!lstat.isDirectory()) continue;

    const flatSkill = resolve(entryPath, "SKILL.md");
    if (existsSync(flatSkill)) {
      const reg = deriveEntry(entry, flatSkill);
      if (registry.skills[entry]) updated++; else added++;
      registry.skills[entry] = reg;
      continue;
    }

    // Namespaced: entry/sub/SKILL.md
    let subs;
    try { subs = readdirSync(entryPath); } catch { continue; }
    for (const sub of subs) {
      const subDir = resolve(entryPath, sub);
      let subStat;
      try { subStat = lstatSync(subDir); } catch { continue; }
      if (!subStat.isDirectory()) continue;
      const subSkill = resolve(subDir, "SKILL.md");
      if (!existsSync(subSkill)) continue;
      const key = `${entry}/${sub}`;
      const reg = deriveEntry(key, subSkill);
      if (registry.skills[key]) updated++; else added++;
      registry.skills[key] = reg;
    }
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

writeFileSync(skillsJsonPath, JSON.stringify(registry, null, 2) + "\n");

if (split > 0 || added > 0 || pruned > 0) {
  process.stderr.write(
    `[session-sync] split=${split} added=${added} updated=${updated} pruned=${pruned}\n`
  );
}
