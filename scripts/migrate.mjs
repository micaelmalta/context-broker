#!/usr/bin/env node
// Migrates MCP server configs from Cursor, Claude Code, OpenCode, or Agents into
// ~/.config/lazygate/servers.json.
// Registers skills and commands in-place (no file moves) in skills.json, and
// splits SKILL.md into frontmatter stub + INSTRUCTIONS.md where they live.
// Detected secrets (env values and Authorization-style headers) are extracted to the
// shell config file (~/.bashrc for bash, ~/.zshenv for zsh, ~/.config/fish/config.fish
// for fish) and replaced with ${VAR} refs.
//
// The broker itself is registered as "lazygate" (replacing a pre-rename "context-broker" entry) in ~/.claude.json and in every other
// source config it migrated entries out of (Cursor, OpenCode), so those clients keep their tools.
//
// Every config file that is modified is backed up first (<file>.bak-<timestamp>) and
// written atomically. Note: project-scoped servers in ~/.claude.json
// (projects[path].mcpServers) are not migrated — only the global ones.
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

import { existsSync, mkdirSync, readdirSync, lstatSync, copyFileSync, readFileSync } from "fs";
import { resolve, dirname, basename, relative, extname } from "path";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import {
  backupFile,
  writeFileAtomic,
  writeJsonSafe,
  readJsonFile,
  findFiles,
  deriveEntry,
  splitSkillMd,
  uniqueSkillKey,
  fromCursorVars,
  mapStrings,
  APP_NAME,
  BROKER_NAMES,
  activeConfigDir,
  adoptLegacyConfigDir,
  removeBrokerEntries,
} from "./lib/shared.mjs";

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
// Pick up a config dir from before the rename (not on --dry-run, which writes nothing).
if (!dryRun) adoptLegacyConfigDir();
const CONFIG_DIR = activeConfigDir();

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
const SECRET_HEADER_RE = /authorization|api[-_]?key|token|secret|password/i;
const MIN_SECRET_LEN = 20;

function isSecret(key, value) {
  if (typeof value !== "string") return false;
  if (value.includes("${")) return false; // already a reference
  if (SECRET_KEY_RE.test(key)) return true;
  if (value.length >= MIN_SECRET_LEN && SECRET_VAL_RE.test(value)) return true;
  return false;
}

const envName = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Replace secret-looking header values (e.g. "Authorization: Bearer abc") with ${VAR} refs.
function extractHeaderSecrets(serverName, headers, secretsToWrite) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v !== "string" || v.includes("${") || !SECRET_HEADER_RE.test(k)) { out[k] = v; continue; }
    const m = v.match(/^(Bearer|Basic|Token)\s+(.+)$/i);
    const prefix = m ? `${m[1]} ` : "";
    const secret = m ? m[2] : v;
    const varName = `${envName(serverName)}_${envName(k)}`;
    secretsToWrite[varName] = secret;
    out[k] = `${prefix}\${${varName}}`;
  }
  return out;
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

// Normalise one source's server table to { name: {type,url,oauth,headers,env} | {command,args,env} }.
function readSourceServers(raw, label) {
  const unvar = label === "cursor" ? (v) => mapStrings(v, fromCursorVars) : (v) => v;
  const servers = {};
  if (raw.mcpServers) {
    for (const [name, cfg] of Object.entries(raw.mcpServers)) {
      if (cfg.type === "http" || cfg.url) {
        servers[name] = { type: "http", url: unvar(cfg.url), oauth: cfg.oauth ?? null, headers: unvar(cfg.headers ?? null), env: unvar(cfg.env ?? {}) };
      } else {
        servers[name] = { command: unvar(cfg.command), args: unvar(cfg.args ?? []), env: unvar(cfg.env ?? {}) };
      }
    }
  } else if (raw.mcp) {
    for (const [name, cfg] of Object.entries(raw.mcp)) {
      if (cfg.type === "remote" || cfg.url) {
        servers[name] = { type: "http", url: cfg.url, oauth: cfg.oauth ?? null, headers: cfg.headers ?? null, env: cfg.environment ?? {} };
      } else {
        const [command, ...cmdArgs] = Array.isArray(cfg.command) ? cfg.command : [cfg.command];
        servers[name] = { command, args: cmdArgs, env: cfg.environment ?? {} };
      }
    }
  } else {
    return null;
  }
  return servers;
}

const unique = (arr) => [...new Set(arr)];

// ─── Servers migration ─────────────────────────────────────────────────────

if (migrateServers) {
  // Guard: helpers are only needed for server migration (not --skills / --plugins)
  const _helpersPath = resolve(__dirname, "..", "dist", "migrate-helpers.js");
  if (!existsSync(_helpersPath)) {
    console.error("✗ dist/migrate-helpers.js not found. Run `npm run build` first.");
    process.exit(1);
  }
  const { detectShellSecretFile, resolveBrokerEntry } = await import(pathToFileURL(_helpersPath).href);

  const outPath = outArg ?? resolve(CONFIG_DIR, "servers.json");
  const existing = readJsonFile(outPath, { servers: {} });
  if (!existing.servers) existing.servers = {};

  const shellSecretFile = detectShellSecretFile();
  let shellSecretContent = existsSync(shellSecretFile.path) ? readFileSync(shellSecretFile.path, "utf-8") : "";
  let shellSecretsDirty = false;

  const settingsPath = resolve(homedir(), ".claude", "settings.json");
  const settings = readJsonFile(settingsPath, null);

  // Source edits are applied only after servers.json is safely written.
  const sourceEdits = [];   // { sourcePath, raw, names }
  const pluginDisables = new Set();
  const seenNames = new Set();

  const SKIP = new Set(["router", "broker", ...BROKER_NAMES]);

  const claudeJsonPath = resolve(homedir(), ".claude.json");
  const brokerEntry = resolveBrokerEntry(resolve(__dirname, "..", "dist"));

  // Add the broker to a non-Claude client's config, in that client's own format.
  function addBroker(raw, key) {
    raw[key] ??= {};
    const legacy = BROKER_NAMES.some((n) => n !== APP_NAME && raw[key][n]);
    if (raw[key][APP_NAME] && !legacy) return false;
    removeBrokerEntries(raw[key]);
    raw[key][APP_NAME] = key === "mcp"
      ? { type: "local", command: [brokerEntry.command, ...brokerEntry.args] }
      : { ...brokerEntry };
    return true;
  }

  // Convert one group of servers (a source file, or the plugin .mcp.json files).
  function convertGroup(label, sourcePath, raw, mcpServers) {
    const converted = {}, skipped = [], secretsToWrite = {};

    for (const [name, cfg] of Object.entries(mcpServers)) {
      if (SKIP.has(name)) { skipped.push(name); continue; }
      if (!cfg.command && !cfg.url) { console.warn(`  ⚠  Skipping "${name}" — no command or url`); skipped.push(name); continue; }

      const prev = existing.servers[name];

      const env = {};
      for (const [k, v] of Object.entries(cfg.env ?? {})) {
        if (isSecret(k, v)) { secretsToWrite[k] = v; env[k] = `\${${k}}`; }
        else env[k] = v;
      }

      // Keep user edits (description, keywords, autoActivate, timeouts) across re-runs.
      const carried = {
        description:  prev?.description ?? `${name} MCP server`,
        keywords:     unique([...(prev?.keywords ?? []), ...deriveKeywords(name, cfg)]),
        migratedFrom: label,
        ...(prev?.toolTimeoutMs ? { toolTimeoutMs: prev.toolTimeoutMs } : {}),
      };

      if (cfg.type === "http" || cfg.url) {
        const headers = cfg.headers ? extractHeaderSecrets(name, cfg.headers, secretsToWrite) : null;
        converted[name] = {
          ...carried,
          type:         "http",
          url:          cfg.url,
          ...(cfg.oauth ? { oauth: cfg.oauth } : {}),
          ...(headers   ? { headers }          : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          autoActivate: prev?.autoActivate ?? false,
        };
      } else {
        converted[name] = {
          ...carried,
          command:      cfg.command,
          args:         cfg.args ?? [],
          ...(Object.keys(env).length > 0 ? { env } : {}),
          autoActivate: prev?.autoActivate ?? false,
        };
      }
      seenNames.add(name);
    }

    // Remember which plugins we disable so revert can re-enable exactly those.
    const toDisable = {};
    for (const [pluginKey, enabled] of Object.entries(settings?.enabledPlugins ?? {})) {
      const pluginName = pluginKey.split("@")[0];
      if (converted[pluginName] && enabled === true) (toDisable[pluginName] ??= []).push(pluginKey);
    }
    for (const [name, keys] of Object.entries(toDisable)) {
      converted[name].disabledPlugins = unique([...(existing.servers[name]?.disabledPlugins ?? []), ...keys]);
      keys.forEach(k => pluginDisables.add(k));
    }

    const added   = Object.keys(converted).filter(k => !existing.servers[k]);
    const updated = Object.keys(converted).filter(k =>  existing.servers[k]);
    Object.assign(existing.servers, converted);

    const newSecrets = Object.entries(secretsToWrite)
      .filter(([k]) => !shellSecretFile.checkExisting(shellSecretContent, k));

    console.log(`\nSource:  ${sourcePath ?? label}`);
    console.log(`Servers: ${Object.keys(mcpServers).length} found → ${Object.keys(converted).length} converted`);
    if (skipped.length)    console.log(`Skipped: ${skipped.join(", ")}`);
    if (added.length)      console.log(`Add:     ${added.join(", ")}`);
    if (updated.length)    console.log(`Update:  ${updated.join(", ")}`);
    if (newSecrets.length) console.log(`Secrets: ${newSecrets.map(([k]) => k).join(", ")} → ${shellSecretFile.label}`);
    else if (Object.keys(secretsToWrite).length > 0) console.log(`Secrets: all already present in ${shellSecretFile.label}`);

    if (!dryRun && newSecrets.length > 0) {
      const block = `\n# MCP Broker secrets — migrated from ${label.replace(/\n/g, " ")} (${new Date().toISOString().slice(0,10)})\n` +
        newSecrets.map(([k, v]) => shellSecretFile.format(k, v)).join("\n") + "\n";
      shellSecretContent += block;
      shellSecretsDirty = true;
    }

    if (raw && sourcePath) sourceEdits.push({ sourcePath, raw, names: new Set(Object.keys(converted)) });
  }

  for (const { label, path: sourcePath } of resolveServerSources()) {
    if (!existsSync(sourcePath)) {
      console.log(`\n⚠  Server config not found: ${sourcePath} — skipping.`);
      continue;
    }

    let raw;
    try {
      raw = readJsonFile(sourcePath);
    } catch (err) {
      console.log(`\n⚠  ${err.message} — skipping.`);
      continue;
    }

    const mcpServers = readSourceServers(raw, label);
    if (!mcpServers) {
      console.log(`\n⚠  Unrecognized server config format in ${sourcePath} — skipping.`);
      continue;
    }
    if (Object.keys(mcpServers).length === 0) continue;
    convertGroup(label, sourcePath, raw, mcpServers);
  }

  // HTTP servers shipped by Claude Code plugins (e.g. Slack) — scanned once and
  // labelled "plugin", not attributed to whichever source happened to run last.
  const pluginsCacheForServers = resolve(homedir(), ".claude", "plugins", "cache");
  if ((!fromArg || fromArg === "claude") && existsSync(pluginsCacheForServers)) {
    const pluginServers = {};
    for (const mcpFile of findFiles(pluginsCacheForServers, { name: ".mcp.json", type: "file", maxDepth: 5 })) {
      try {
        const pluginMcp = readJsonFile(mcpFile);
        for (const [name, cfg] of Object.entries(pluginMcp.mcpServers ?? {})) {
          if ((cfg.type === "http" || cfg.url) && !seenNames.has(name) && !pluginServers[name]) {
            pluginServers[name] = { type: "http", url: cfg.url, oauth: cfg.oauth ?? null, headers: cfg.headers ?? null, env: {} };
          }
        }
      } catch { /* skip malformed */ }
    }
    if (Object.keys(pluginServers).length > 0) {
      convertGroup("plugin", `${pluginsCacheForServers} (plugin .mcp.json files)`, null, pluginServers);
    }
  }

  // ── Write everything, safest-first: secrets → servers.json → source edits ──
  if (dryRun) {
    console.log("\n--- servers.json (dry run) ---");
    console.log(JSON.stringify(existing, null, 2));
    console.log("--- (not written) ---");
  } else {
    if (shellSecretsDirty) {
      const bak = backupFile(shellSecretFile.path);
      writeFileAtomic(shellSecretFile.path, shellSecretContent);
      console.log(`✓ Written: ${shellSecretFile.path}${bak ? ` (backup: ${bak})` : ""}`);
    }

    writeJsonSafe(outPath, existing);
    console.log(`\n✓ Written: ${outPath}`);

    // Remove migrated entries from source configs so they don't load twice
    for (const { sourcePath, raw, names } of sourceEdits) {
      const key = raw.mcpServers ? "mcpServers" : "mcp";
      raw[key] = Object.fromEntries(Object.entries(raw[key] ?? {}).filter(([n]) => !names.has(n)));
      // ~/.claude.json gets its broker entry below; other clients need it here.
      const registered = resolve(sourcePath) !== claudeJsonPath && addBroker(raw, key);
      if (writeJsonSafe(sourcePath, raw)) {
        console.log(`✓ Removed ${names.size} entries from ${sourcePath}`);
        if (registered) console.log(`✓ Registered ${APP_NAME} in ${sourcePath}`);
      }
    }

    // Disable plugins whose MCP server was migrated (avoids double-loading)
    if (settings && pluginDisables.size > 0) {
      const plugins = settings.enabledPlugins ?? {};
      for (const k of pluginDisables) plugins[k] = false;
      writeJsonSafe(settingsPath, settings);
      console.log(`✓ Disabled ${pluginDisables.size} plugin(s) in ${settingsPath}`);
    }
  }

  // ─── Register context-broker router in ~/.claude.json ───────────────────
  if (dryRun) {
    for (const { sourcePath } of sourceEdits) {
      if (resolve(sourcePath) !== claudeJsonPath) console.log(`\n  Would register ${APP_NAME} in ${sourcePath}`);
    }
    console.log("\n--- ~/.claude.json broker entry (dry run) ---");
    console.log(JSON.stringify({ [APP_NAME]: brokerEntry }, null, 2));
    console.log("--- (not written) ---");
  } else {
    const claudeJson = readJsonFile(claudeJsonPath, {});
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    const hadLegacy = BROKER_NAMES.some((n) => n !== APP_NAME && claudeJson.mcpServers[n]);
    if (!claudeJson.mcpServers[APP_NAME] || hadLegacy) {
      removeBrokerEntries(claudeJson.mcpServers);
      claudeJson.mcpServers[APP_NAME] = brokerEntry;
      writeJsonSafe(claudeJsonPath, claudeJson);
      console.log(`✓ Registered ${APP_NAME} in ${claudeJsonPath}${hadLegacy ? " (replaced legacy context-broker entry)" : ""}`);
    } else {
      console.log(`  ${APP_NAME} already registered in ${claudeJsonPath} — skipped`);
    }
  }
}

// ─── Skills migration ──────────────────────────────────────────────────────
// Skills and commands stay in their original directories — only paths are
// registered in skills.json. SKILL.md files are split into stub + INSTRUCTIONS.md
// in-place.

if (migrateSkills) {
  const skillsOutPath = skillsOutArg ?? resolve(CONFIG_DIR, "skills.json");

  const existingSkills = readJsonFile(skillsOutPath, { skills: {} });
  if (!existingSkills.skills) existingSkills.skills = {};

  for (const { label, path: skillsDir } of resolveSkillSources()) {
    if (!existsSync(skillsDir)) {
      console.log(`\n⚠  Skills directory not found: ${skillsDir} — skipping.`);
      continue;
    }

    const converted = {};
    const skipped = [];

    // Same-named skills from different sources get "<name>@<label>" instead of clobbering.
    const claim = (key, path) => uniqueSkillKey({ ...existingSkills.skills, ...converted }, key, path, label);

    // Register all commands/*.md from a commands dir under a given key prefix
    function registerCommands(keyPrefix, commandsDir) {
      if (!existsSync(commandsDir)) return;
      for (const file of readdirSync(commandsDir)) {
        if (extname(file) !== ".md") continue;
        const cmdPath = resolve(commandsDir, file);
        const cmdKey = claim(`${keyPrefix}:${basename(file, ".md")}`, cmdPath);
        converted[cmdKey] = deriveEntry(cmdKey, cmdPath, { migratedFrom: label }, { command: true });
      }
    }

    function registerSkill(key, skillPath, commandsDir) {
      const k = claim(key, skillPath);
      converted[k] = deriveEntry(k, skillPath, { migratedFrom: label });
      registerCommands(k, commandsDir);
    }

    for (const entry of readdirSync(skillsDir)) {
      const entryPath = resolve(skillsDir, entry);
      const lstat = lstatSync(entryPath);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) continue;

      const skillPath = resolve(entryPath, "SKILL.md");
      if (existsSync(skillPath)) {
        // Flat skill with SKILL.md
        registerSkill(entry, skillPath, resolve(entryPath, "commands"));
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
          registerSkill(`${entry}/${sub}`, subSkillPath, resolve(subPath, "commands"));
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
      for (const [key, cfg] of Object.entries(converted)) {
        if (!cfg.path.endsWith("SKILL.md")) continue;
        if (splitSkillMd(cfg.path, key)) {
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
    writeJsonSafe(skillsOutPath, existingSkills);
    console.log(`✓ Written: ${skillsOutPath}`);
  }
}

// ─── Plugins migration ─────────────────────────────────────────────────────
// Plugins stay in ~/.claude/plugins/cache — only paths are registered.
// SKILL.md files are split into stub + INSTRUCTIONS.md in-place.

if (migratePlugins) {
  const pluginsCache = resolve(homedir(), ".claude", "plugins", "cache");
  const skillsOutPath = skillsOutArg ?? resolve(CONFIG_DIR, "skills.json");

  if (!existsSync(pluginsCache)) {
    console.log(`\n⚠  Plugins cache not found: ${pluginsCache} — skipping plugins migration.`);
  } else {
    const skillFiles = findFiles(pluginsCache, { name: "SKILL.md", type: "file", maxDepth: 10 });
    const commandsDirs = findFiles(pluginsCache, { name: "commands", type: "dir", maxDepth: 6 });

    const existingSkills = readJsonFile(skillsOutPath, { skills: {} });
    if (!existingSkills.skills) existingSkills.skills = {};

    let splitCount = 0;
    const converted = {};

    // Register skills from SKILL.md files
    for (const skillPath of skillFiles) {
      const skillDir = dirname(skillPath);
      const skillName = basename(skillDir);
      const rel = relative(pluginsCache, skillDir).split("/");
      const pluginName = rel[1] ?? skillName;
      const key = `${pluginName}:${skillName}`;

      if (!dryRun && splitSkillMd(skillPath, key)) splitCount++;
      converted[key] = deriveEntry(key, skillPath, { plugin: pluginName });
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
        const key = `${pluginName}:${basename(file, ".md")}`;
        if (converted[key]) continue; // skill takes priority
        converted[key] = deriveEntry(key, resolve(commandsDir, file), { plugin: pluginName }, { command: true });
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
      writeJsonSafe(skillsOutPath, merged);
      if (splitCount > 0) console.log(`✓ Split:   ${splitCount} SKILL.md file(s)`);
      console.log(`✓ Written: ${skillsOutPath}`);

      // Install session-sync.mjs (+ its lib/) into ~/.config/lazygate/scripts/
      const scriptsDstDir = resolve(CONFIG_DIR, "scripts");
      mkdirSync(resolve(scriptsDstDir, "lib"), { recursive: true });
      copyFileSync(resolve(__dirname, "session-sync.mjs"), resolve(scriptsDstDir, "session-sync.mjs"));
      copyFileSync(resolve(__dirname, "lib", "shared.mjs"), resolve(scriptsDstDir, "lib", "shared.mjs"));
      console.log(`✓ Installed: ${resolve(scriptsDstDir, "session-sync.mjs")}`);

      // Add SessionStart hook to keep skills fresh after plugin/agent updates
      const settingsPath = resolve(homedir(), ".claude", "settings.json");
      const settings = readJsonFile(settingsPath, {});
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      const hookCmd = `node ~/.config/${APP_NAME}/scripts/session-sync.mjs`;
      // Drop a hook that points at the pre-rename directory; it is re-added below.
      const isLegacyHook = (h) => h.command?.includes("context-broker/scripts/session-sync.mjs");
      const before = settings.hooks.SessionStart.length;
      settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
        (entry) => !entry.hooks?.some(isLegacyHook)
      );
      const replacedLegacy = settings.hooks.SessionStart.length !== before;
      const alreadyPresent = settings.hooks.SessionStart.some(entry =>
        entry.hooks?.some(h => h.command === hookCmd)
      );
      if (!alreadyPresent || replacedLegacy) {
        if (!alreadyPresent) {
          settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: hookCmd }] });
        }
        writeJsonSafe(settingsPath, settings);
        console.log(`✓ Added SessionStart hook → ${settingsPath}`);
      } else {
        console.log(`  SessionStart hook already present — skipped`);
      }
    }
  }
}

console.log();
