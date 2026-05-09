#!/usr/bin/env node
// Splits plugin SKILL.md files into a frontmatter stub + INSTRUCTIONS.md body,
// then re-syncs ~/.config/context-broker/skills.json with the current plugin state.
// Idempotent: only re-splits SKILL.md files that lack a sibling INSTRUCTIONS.md
// (i.e. files that were overwritten by a plugin update).
// Run at SessionStart so splits and registry stay fresh after plugin updates.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, basename, relative } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const pluginsCache = resolve(homedir(), ".claude", "plugins", "cache");
const skillsJsonPath = resolve(homedir(), ".config", "context-broker", "skills.json");

// ─── Split SKILL.md files ──────────────────────────────────────────────────

let skillFiles;
try {
  skillFiles = execSync(`find "${pluginsCache}" -name "SKILL.md"`, { encoding: "utf-8" })
    .trim().split("\n").filter(Boolean);
} catch {
  process.exit(0);
}

let split = 0, skipped = 0;

for (const skillPath of skillFiles) {
  const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");

  if (existsSync(instructionsPath)) { skipped++; continue; }

  const content = readFileSync(skillPath, "utf-8");
  const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) { skipped++; continue; }

  const body = match[2].replace(/^\n+/, "");
  if (!body) { skipped++; continue; }

  writeFileSync(skillPath, match[1]);
  writeFileSync(instructionsPath, body);
  split++;
}

// ─── Re-sync plugin skills in skills.json ─────────────────────────────────

if (!existsSync(skillsJsonPath)) process.exit(0);

const registry = JSON.parse(readFileSync(skillsJsonPath, "utf-8"));

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

// Remove stale plugin entries (plugin was uninstalled or version changed)
for (const [key, cfg] of Object.entries(registry.skills)) {
  if (cfg.plugin && !existsSync(cfg.path)) {
    delete registry.skills[key];
  }
}

// Register / update all current plugin skills
let registered = 0;
for (const skillPath of skillFiles) {
  const skillDir = dirname(skillPath);
  const skillName = basename(skillDir);
  const rel = relative(pluginsCache, skillDir).split("/");
  const pluginName = rel[1] ?? skillName;
  const registryKey = `${pluginName}:${skillName}`;

  const fm = parseFrontmatter(readFileSync(skillPath, "utf-8"));
  const description = fm.description ?? `Skill: ${skillName}`;

  const words = new Set();
  skillName.toLowerCase().split(/[-_]+/).filter(w => w.length > 2).forEach(w => words.add(w));
  description.toLowerCase().split(/\W+/).filter(w => w.length > 4).forEach(w => words.add(w));
  const keywords = [...words].slice(0, 12);

  registry.skills[registryKey] = {
    description,
    keywords,
    path: skillPath,
    plugin: pluginName,
  };
  registered++;
}

writeFileSync(skillsJsonPath, JSON.stringify(registry, null, 2) + "\n");

if (split > 0 || registered > 0) {
  process.stderr.write(
    `[split-skills] Split ${split} skills, registered ${registered} plugin skills` +
    ` (${skipped} already split)\n`
  );
}
