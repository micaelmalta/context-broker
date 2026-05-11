#!/usr/bin/env node
// Migrates MCP server configs from Cursor, Claude Code, OpenCode, or Agents into
// ~/.config/context-broker/servers.json.
// Registers skills and commands in-place (no file moves) in skills.json, and
// splits SKILL.md into frontmatter stub + INSTRUCTIONS.md where they live.
// Detected secrets are extracted to the shell config file (~/.bashrc for bash,
// ~/.zshenv for zsh, ~/.config/fish/config.fish for fish) and replaced with ${VAR} refs.
// Requires: npm run build (produces dist/migrate-helpers.js)
//
// Usage:
//   node scripts/migrate.mjs                        # auto-discovers all sources
//   node scripts/migrate.mjs --from cursor          # restrict to one source
//   node scripts/migrate.mjs --from claude
//   node scripts/migrate.mjs --from opencode
//   node scripts/migrate.mjs --from agents
//   node scripts/migrate.mjs --from /path/to/file
//   node scripts/migrate.mjs --out /custom/servers.json
//   node scripts/migrate.mjs --skills-out /custom/skills.json
//   node scripts/migrate.mjs --plugins
//   node scripts/migrate.mjs --dry-run

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync, copyFileSync } from "fs";
import { resolve, dirname, basename, relative, extname } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const fromArg         = get("--from");
const outArg          = get("--out");
const skillsOutArg    = get("--skills-out");
const dryRun          = has("--dry-run");
const explicitSkills  = has("--skills");
const explicitPlugins = has("--plugins");
// Run everything by default unless specific flags are provided
const migrateServers = !explicitSkills && !explicitPlugins || has("--servers");
const migrateSkills  = explicitSkills  || (!explicitPlugins && !has("--servers"));
const migratePlugins = explicitPlugins || (!explicitSkills  && !has("--servers"));

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

function resolveServerSources() {
  if (fromArg) {
    const path = SERVER_SOURCES[fromArg] ?? resolve(fromArg);
    return [{ label: fromArg, path }];
  }
  return Object.entries(SERVER_SOURCES).map(([label, path]) => ({ label, path }));
}

function resolveSkillSources() {
  if (fromArg) {
    const path = SKILLS_SOURCES[fromArg] ?? resolve(fromArg, "skills");
    return [{ label: fromArg, path }];
  }
  return Object.entries(SKILLS_SOURCES).map(([label, path]) => ({ label, path }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_PASS|_CREDENTIAL|_DSN|_URI|_CERT|_PRIVATE)$/i;
const SECRET_VAL_RE = /^(ATATT|ghp_|gho_|glpat-|sk-|xox[bpoas]-|ey[A-Za-z0-9])/;
const MIN_SECRET_LEN = 20;

function isSecret(key, value) {
  if (typeof value !== "string") return false;
  if (SECRET_KEY_RE.test(key)) return true;
  if (value.length >= MIN_SECRET_LEN && SECRET_VAL_RE.test(value)) return true;
  return false;
}

function deriveKeywords(name, cfg) {
  const words = new Set();
  name.toLowerCase().split(/[-_\s]+/).forEach(w => w.length > 2 && words.add(w));
  const text = [cfg.command, ...(cfg.args ?? []), cfg.url ?? ""].join(" ").toLowerCase();
  for (const kw of ["github", "jira", "confluence", "slack", "google", "aws",
                    "mysql", "postgres", "sqlite", "redis", "fetch", "web",
                    "search", "file", "git", "docker", "kubernetes", "eks",
                    "langsmith", "datadog", "linear", "notion", "figma",
                    "linkedin", "atlassian", "pagerduty"]) {
    if (text.includes(kw)) words.add(kw);
  }
  return [...words];
}

// Split a SKILL.md into frontmatter stub + INSTRUCTIONS.md in-place.
// Returns true if a split was performed.
function splitSkillMd(skillPath) {
  if (!existsSync(skillPath)) return false;
  const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  if (existsSync(instructionsPath)) return false;
  const content = readFileSync(skillPath, "utf-8");
  const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) return false;
  const body = match[2].replace(/^\n+/, "");
  if (!body) return false;
  writeFileSync(skillPath, match[1]);
  writeFileSync(instructionsPath, body);
  return true;
}

// Build a registry entry from a SKILL.md path.
// If the file has a frontmatter `description` field, it takes priority over the first prose line.
function skillEntry(key, skillPath, extra = {}) {
  const content = readFileSync(skillPath, "utf-8");
  const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
  let fmDescription = null;
  if (fmMatch) {
    const descMatch = fmMatch[0].match(/^description:\s*(.+)$/m);
    if (descMatch) fmDescription = descMatch[1].trim().replace(/^["']|["']$/g, "");
  }
  const firstLine = content.split("\n").find(l => l.match(/^[A-Za-z]/)) ?? "";
  const description = (fmDescription ?? firstLine).slice(0, 120) || `Skill: ${key}`;
  const words = new Set();
  key.toLowerCase().split(/[-_/\s:]+/).forEach(w => w.length > 2 && words.add(w));
  description.toLowerCase().split(/\W+/).filter(w => w.length > 4).slice(0, 6).forEach(w => words.add(w));
  return { description, keywords: [...words], path: skillPath, ...extra };
}

// Build a registry entry from a command .md path.
function commandEntry(key, cmdPath, extra = {}) {
  const content = readFileSync(cmdPath, "utf-8");
  const firstLine = content.split("\n").find(l => l.match(/^[A-Za-z]/)) ?? "";
  const description = firstLine.replace(/^#+\s*/, "").slice(0, 120) || `Command: ${key}`;
  const words = new Set();
  key.toLowerCase().split(/[-_/\s:]+/).forEach(w => w.length > 2 && words.add(w));
  description.toLowerCase().split(/\W+/).filter(w => w.length > 4).slice(0, 8).forEach(w => words.add(w));
  return { description, keywords: [...words], path: cmdPath, ...extra };
}

// ─── Servers migration ─────────────────────────────────────────────────────

if (migrateServers) {
  // Guard: helpers are only needed for server migration (not --skills / --plugins)
  const _helpersPath = resolve(__dirname, "..", "dist", "migrate-helpers.js");
  if (!existsSync(_helpersPath)) {
    console.error("✗ dist/migrate-helpers.js not found. Run `npm run build` first.");
    process.exit(1);
  }
  const { detectShellSecretFile, resolveBrokerEntry } = await import(pathToFileURL(_helpersPath).href);

  const outPath = outArg ?? resolve(homedir(), ".config", "context-broker", "servers.json");
  let existing = { servers: {} };
  if (existsSync(outPath)) existing = JSON.parse(readFileSync(outPath, "utf-8"));

  const shellSecretFile = detectShellSecretFile();
  let shellSecretContent = existsSync(shellSecretFile.path) ? readFileSync(shellSecretFile.path, "utf-8") : "";
  const allSecrets = {};

  for (const { label, path: sourcePath } of resolveServerSources()) {
    if (!existsSync(sourcePath)) {
      console.log(`\n⚠  Server config not found: ${sourcePath} — skipping.`);
      continue;
    }

    const raw = JSON.parse(readFileSync(sourcePath, "utf-8"));

    let mcpServers = {};
    if (raw.mcpServers) {
      for (const [name, cfg] of Object.entries(raw.mcpServers)) {
        if (cfg.type === "http" || cfg.url) {
          mcpServers[name] = { type: "http", url: cfg.url, oauth: cfg.oauth ?? null, headers: cfg.headers ?? null, env: cfg.env ?? {} };
        } else {
          mcpServers[name] = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
        }
      }
    } else if (raw.mcp) {
      for (const [name, cfg] of Object.entries(raw.mcp)) {
        if (cfg.type === "remote" || cfg.url) {
          mcpServers[name] = { type: "http", url: cfg.url, oauth: cfg.oauth ?? null, headers: cfg.headers ?? null, env: cfg.environment ?? {} };
        } else {
          const [command, ...cmdArgs] = Array.isArray(cfg.command) ? cfg.command : [cfg.command];
          mcpServers[name] = { command, args: cmdArgs, env: cfg.environment ?? {} };
        }
      }
    } else {
      console.log(`\n⚠  Unrecognized server config format in ${sourcePath} — skipping.`);
      continue;
    }

    // Also pull in HTTP servers from plugin .mcp.json files (e.g. Slack)
    const pluginsCache = resolve(homedir(), ".claude", "plugins", "cache");
    if (existsSync(pluginsCache)) {
      let pluginMcpFiles = [];
      try {
        pluginMcpFiles = execSync(`find "${pluginsCache}" -name ".mcp.json" -maxdepth 5`, { encoding: "utf-8" })
          .trim().split("\n").filter(Boolean);
      } catch { /* ignore */ }
      for (const mcpFile of pluginMcpFiles) {
        try {
          const pluginMcp = JSON.parse(readFileSync(mcpFile, "utf-8"));
          for (const [name, cfg] of Object.entries(pluginMcp.mcpServers ?? {})) {
            if ((cfg.type === "http" || cfg.url) && !mcpServers[name]) {
              mcpServers[name] = { type: "http", url: cfg.url, oauth: cfg.oauth ?? null, headers: cfg.headers ?? null, env: {} };
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    if (Object.keys(mcpServers).length === 0) continue;

    const SKIP = new Set(["router", "broker", "context-broker"]);
    const converted = {}, skipped = [], secretsToWrite = {};

    for (const [name, cfg] of Object.entries(mcpServers)) {
      if (SKIP.has(name)) { skipped.push(name); continue; }
      if (!cfg.command && !cfg.url) { console.warn(`  ⚠  Skipping "${name}" — no command or url`); skipped.push(name); continue; }

      const env = {};
      for (const [k, v] of Object.entries(cfg.env ?? {})) {
        if (isSecret(k, v)) { secretsToWrite[k] = v; env[k] = `\${${k}}`; }
        else env[k] = v;
      }

      if (cfg.type === "http" || cfg.url) {
        converted[name] = {
          description:  `Migrated from ${label}`,
          keywords:     deriveKeywords(name, cfg),
          type:         "http",
          url:          cfg.url,
          ...(cfg.oauth   ? { oauth: cfg.oauth }     : {}),
          ...(cfg.headers ? { headers: cfg.headers } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          autoActivate: false,
        };
      } else {
        converted[name] = {
          description:  `Migrated from ${label}`,
          keywords:     deriveKeywords(name, cfg),
          command:      cfg.command,
          args:         cfg.args ?? [],
          ...(Object.keys(env).length > 0 ? { env } : {}),
          autoActivate: false,
        };
      }
    }

    const added   = Object.keys(converted).filter(k => !existing.servers[k]);
    const updated = Object.keys(converted).filter(k =>  existing.servers[k]);
    Object.assign(existing.servers, converted);
    Object.assign(allSecrets, secretsToWrite);

    const newSecrets = Object.entries(secretsToWrite)
      .filter(([k]) => !shellSecretFile.checkExisting(shellSecretContent, k));

    console.log(`\nSource:  ${sourcePath}`);
    console.log(`Servers: ${Object.keys(mcpServers).length} found → ${Object.keys(converted).length} converted`);
    if (skipped.length)    console.log(`Skipped: ${skipped.join(", ")}`);
    if (added.length)      console.log(`Add:     ${added.join(", ")}`);
    if (updated.length)    console.log(`Update:  ${updated.join(", ")}`);
    if (newSecrets.length) console.log(`Secrets: ${newSecrets.map(([k]) => k).join(", ")} → ${shellSecretFile.label}`);
    else if (Object.keys(secretsToWrite).length > 0) console.log(`Secrets: all already present in ${shellSecretFile.label}`);

    if (!dryRun) {
      // Append new secrets to the shell config file (fish or zsh/bash)
      if (newSecrets.length > 0) {
        const block = `\n# MCP Broker secrets — migrated from ${label.replace(/\n/g, " ")} (${new Date().toISOString().slice(0,10)})\n` +
          newSecrets.map(([k, v]) => shellSecretFile.format(k, v)).join("\n") + "\n";
        shellSecretContent += block;
        mkdirSync(dirname(shellSecretFile.path), { recursive: true });
        writeFileSync(shellSecretFile.path, shellSecretContent);
        console.log(`✓ Written: ${shellSecretFile.path} (${newSecrets.length} secrets added)`);
      }

      // Remove migrated entries from source config so they don't load twice
      const migratedNames = new Set(Object.keys(converted));
      const remaining = Object.fromEntries(
        Object.entries(raw.mcpServers ?? raw.mcp ?? {}).filter(([n]) => !migratedNames.has(n))
      );
      if (raw.mcpServers) raw.mcpServers = remaining;
      else if (raw.mcp) raw.mcp = remaining;
      writeFileSync(sourcePath, JSON.stringify(raw, null, 2) + "\n");
      console.log(`✓ Removed ${migratedNames.size} entries from ${sourcePath}`);

      // Disable plugins whose MCP server was migrated (avoids double-loading)
      const settingsPath = resolve(homedir(), ".claude", "settings.json");
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const plugins = settings.enabledPlugins ?? {};
        let disabledCount = 0;
        for (const pluginKey of Object.keys(plugins)) {
          const pluginName = pluginKey.split("@")[0];
          if (migratedNames.has(pluginName) && plugins[pluginKey] === true) {
            plugins[pluginKey] = false;
            disabledCount++;
          }
        }
        if (disabledCount > 0) {
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log(`✓ Disabled ${disabledCount} plugin(s) in ${settingsPath}`);
        }
      }
    }
  }

  if (dryRun) {
    console.log("\n--- servers.json (dry run) ---");
    console.log(JSON.stringify(existing, null, 2));
    console.log("--- (not written) ---");
  } else {
    mkdirSync(resolve(outPath, ".."), { recursive: true });
    writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n");
    console.log(`\n✓ Written: ${outPath}`);
  }

  // ─── Register context-broker router in ~/.claude.json ───────────────────
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  const brokerEntry = resolveBrokerEntry(resolve(__dirname, "..", "dist"));

  if (dryRun) {
    console.log("\n--- ~/.claude.json broker entry (dry run) ---");
    console.log(JSON.stringify({ "context-broker": brokerEntry }, null, 2));
    console.log("--- (not written) ---");
  } else {
    const claudeJson = existsSync(claudeJsonPath) ? JSON.parse(readFileSync(claudeJsonPath, "utf-8")) : {};
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    if (!claudeJson.mcpServers["context-broker"]) {
      claudeJson.mcpServers["context-broker"] = brokerEntry;
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n");
      console.log(`✓ Registered context-broker in ${claudeJsonPath}`);
    } else {
      console.log(`  context-broker already registered in ${claudeJsonPath} — skipped`);
    }
  }
}

// ─── Skills migration ──────────────────────────────────────────────────────
// Skills and commands stay in their original directories — only paths are
// registered in skills.json. SKILL.md files are split into stub + INSTRUCTIONS.md
// in-place.

if (migrateSkills) {
  const skillsOutPath = skillsOutArg ?? resolve(homedir(), ".config", "context-broker", "skills.json");

  let existingSkills = { skills: {} };
  if (existsSync(skillsOutPath)) {
    existingSkills = JSON.parse(readFileSync(skillsOutPath, "utf-8"));
  }

  for (const { label, path: skillsDir } of resolveSkillSources()) {
    if (!existsSync(skillsDir)) {
      console.log(`\n⚠  Skills directory not found: ${skillsDir} — skipping.`);
      continue;
    }

    const converted = {};
    const skipped = [];

    // Register all commands/*.md from a commands dir under a given key prefix
    function registerCommands(keyPrefix, commandsDir) {
      if (!existsSync(commandsDir)) return;
      for (const file of readdirSync(commandsDir)) {
        if (extname(file) !== ".md") continue;
        const cmdName = basename(file, ".md");
        const cmdKey = `${keyPrefix}:${cmdName}`;
        converted[cmdKey] = commandEntry(cmdKey, resolve(commandsDir, file), { migratedFrom: label });
      }
    }

    for (const entry of readdirSync(skillsDir)) {
      const entryPath = resolve(skillsDir, entry);
      const lstat = lstatSync(entryPath);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) continue;

      const skillPath = resolve(entryPath, "SKILL.md");
      if (existsSync(skillPath)) {
        // Flat skill with SKILL.md
        converted[entry] = skillEntry(entry, skillPath, { migratedFrom: label });
        registerCommands(entry, resolve(entryPath, "commands"));
      } else {
        // Check for namespaced skills (subdirs with SKILL.md)
        let hasSkills = false;
        for (const sub of readdirSync(entryPath)) {
          const subPath = resolve(entryPath, sub);
          const subLstat = lstatSync(subPath);
          if (subLstat.isSymbolicLink() || !subLstat.isDirectory()) continue;
          const subSkillPath = resolve(subPath, "SKILL.md");
          if (!existsSync(subSkillPath)) continue;
          hasSkills = true;
          const key = `${entry}/${sub}`;
          converted[key] = skillEntry(key, subSkillPath, { migratedFrom: label });
          registerCommands(key, resolve(subPath, "commands"));
        }

        if (!hasSkills) {
          // Commands-only package (e.g. skill.json + commands/ but no SKILL.md)
          const commandsDir = resolve(entryPath, "commands");
          if (existsSync(commandsDir) && readdirSync(commandsDir).some(f => extname(f) === ".md")) {
            registerCommands(entry, commandsDir);
          } else {
            skipped.push(`${entry} (no SKILL.md)`);
          }
        }
      }
    }

    if (Object.keys(converted).length === 0 && skipped.length === 0) {
      console.log(`\n⚠  No skills found in ${skillsDir} — skipping.`);
      continue;
    }

    const added   = Object.keys(converted).filter(k => !existingSkills.skills[k]);
    const updated = Object.keys(converted).filter(k =>  existingSkills.skills[k]);
    Object.assign(existingSkills.skills, converted);

    console.log(`\nSkills source: ${skillsDir}`);
    if (added.length)   console.log(`Add:           ${added.join(", ")}`);
    if (updated.length) console.log(`Update:        ${updated.join(", ")}`);
    if (skipped.length) console.log(`Skipped:       ${skipped.join(", ")}`);

    if (!dryRun) {
      let splitCount = 0;
      for (const cfg of Object.values(converted)) {
        if (!cfg.path.endsWith("SKILL.md")) continue;
        if (splitSkillMd(cfg.path)) {
          splitCount++;
          console.log(`✓ Split:  ${cfg.path}`);
        }
      }
      if (splitCount > 0) console.log(`✓ Split ${splitCount} SKILL.md file(s)`);
    }
  }

  if (dryRun) {
    console.log("\n--- skills.json (dry run) ---");
    console.log(JSON.stringify(existingSkills, null, 2));
    console.log("--- (not written) ---");
  } else {
    mkdirSync(resolve(skillsOutPath, ".."), { recursive: true });
    writeFileSync(skillsOutPath, JSON.stringify(existingSkills, null, 2) + "\n");
    console.log(`✓ Written: ${skillsOutPath}`);
  }
}

// ─── Plugins migration ─────────────────────────────────────────────────────
// Plugins stay in ~/.claude/plugins/cache — only paths are registered.
// SKILL.md files are split into stub + INSTRUCTIONS.md in-place.

if (migratePlugins) {
  const pluginsCache = resolve(homedir(), ".claude", "plugins", "cache");
  const skillsOutPath = skillsOutArg ?? resolve(homedir(), ".config", "context-broker", "skills.json");

  if (!existsSync(pluginsCache)) {
    console.log(`\n⚠  Plugins cache not found: ${pluginsCache} — skipping plugins migration.`);
  } else {
    let skillFiles;
    try {
      skillFiles = execSync(`find "${pluginsCache}" -name "SKILL.md"`, { encoding: "utf-8" })
        .trim().split("\n").filter(Boolean);
    } catch {
      skillFiles = [];
    }

    let commandsDirs;
    try {
      commandsDirs = execSync(`find "${pluginsCache}" -type d -name "commands" -maxdepth 6`, { encoding: "utf-8" })
        .trim().split("\n").filter(Boolean);
    } catch {
      commandsDirs = [];
    }

    let existingSkills = { skills: {} };
    if (existsSync(skillsOutPath)) {
      existingSkills = JSON.parse(readFileSync(skillsOutPath, "utf-8"));
    }

    let splitCount = 0;
    const converted = {};

    // Register skills from SKILL.md files
    for (const skillPath of skillFiles) {
      const skillDir = dirname(skillPath);
      const skillName = basename(skillDir);
      const rel = relative(pluginsCache, skillDir).split("/");
      const pluginName = rel[1] ?? skillName;
      const key = `${pluginName}:${skillName}`;

      converted[key] = skillEntry(key, skillPath, { plugin: pluginName });

      if (!dryRun && splitSkillMd(skillPath)) splitCount++;
    }

    // Register commands from commands/ directories
    // Skills (SKILL.md entries) take priority — don't overwrite with commands
    for (const commandsDir of commandsDirs) {
      const parentDir = dirname(commandsDir);
      const rel = relative(pluginsCache, parentDir).split("/");
      const pluginName = rel[1] ?? rel[0];
      if (!pluginName) continue;

      // Skip commands/ inside a skill subdir (those skill entries are already registered above)
      if (existsSync(resolve(parentDir, "SKILL.md"))) continue;

      for (const file of readdirSync(commandsDir)) {
        if (extname(file) !== ".md") continue;
        const cmdName = basename(file, ".md");
        const key = `${pluginName}:${cmdName}`;
        if (converted[key]) continue; // skill takes priority
        converted[key] = commandEntry(key, resolve(commandsDir, file), { plugin: pluginName });
      }
    }

    const added   = Object.keys(converted).filter(k => !existingSkills.skills[k]);
    const updated = Object.keys(converted).filter(k =>  existingSkills.skills[k]);
    const merged  = { skills: { ...existingSkills.skills, ...converted } };

    console.log(`\nPlugins cache: ${pluginsCache}`);
    console.log(`Skills out:    ${skillsOutPath}`);
    if (added.length)   console.log(`Add:           ${added.length} entries`);
    if (updated.length) console.log(`Update:        ${updated.length} entries`);

    if (dryRun) {
      console.log("\n--- skills.json plugin entries (dry run) ---");
      console.log(JSON.stringify(converted, null, 2));
      console.log("--- (not written) ---");
    } else {
      mkdirSync(resolve(skillsOutPath, ".."), { recursive: true });
      writeFileSync(skillsOutPath, JSON.stringify(merged, null, 2) + "\n");
      if (splitCount > 0) console.log(`✓ Split:   ${splitCount} SKILL.md file(s)`);
      console.log(`✓ Written: ${skillsOutPath}`);

      // Install session-sync.mjs into ~/.config/context-broker/scripts/
      const scriptsSrc = resolve(__dirname, "session-sync.mjs");
      const scriptsDst = resolve(homedir(), ".config", "context-broker", "scripts", "session-sync.mjs");
      mkdirSync(dirname(scriptsDst), { recursive: true });
      copyFileSync(scriptsSrc, scriptsDst);
      console.log(`✓ Installed: ${scriptsDst}`);

      // Add SessionStart hook to keep skills fresh after plugin/agent updates
      const settingsPath = resolve(homedir(), ".claude", "settings.json");
      const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      const hookCmd = "node ~/.config/context-broker/scripts/session-sync.mjs";
      const alreadyPresent = settings.hooks.SessionStart.some(entry =>
        entry.hooks?.some(h => h.command === hookCmd)
      );
      if (!alreadyPresent) {
        settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: hookCmd }] });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log(`✓ Added SessionStart hook → ${settingsPath}`);
      } else {
        console.log(`  SessionStart hook already present — skipped`);
      }
    }
  }
}

console.log();
