#!/usr/bin/env node
// Migrates MCP server configs from Cursor, Claude Code, or OpenCode into
// ~/.config/context-broker/servers.json.
// With --skills, moves ~/.claude/skills/ into ~/.config/context-broker/skills/,
// registers them in skills.json, and leaves a symlink in the source dir so
// slash commands (/loi, /loi-generate, etc.) keep working.
// With --plugins, splits ~/.claude/plugins/cache/**/SKILL.md into stubs +
// INSTRUCTIONS.md and registers all plugin skills in skills.json.
// Detected secrets are extracted to ~/.zshenv and replaced with ${VAR} refs.
//
// Usage:
//   node scripts/migrate.mjs --from cursor
//   node scripts/migrate.mjs --from claude
//   node scripts/migrate.mjs --from opencode
//   node scripts/migrate.mjs --from /path/to/file
//   node scripts/migrate.mjs --from cursor --out /custom/servers.json
//   node scripts/migrate.mjs --from claude --skills
//   node scripts/migrate.mjs --from claude --skills --skills-out /custom/skills.json
//   node scripts/migrate.mjs --from claude --plugins
//   node scripts/migrate.mjs --from cursor --dry-run

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, symlinkSync, copyFileSync } from "fs";
import { resolve, dirname, basename, relative } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const fromArg        = get("--from");
const outArg         = get("--out");
const skillsOutArg   = get("--skills-out");
const dryRun         = has("--dry-run");
const explicitSkills  = has("--skills");
const explicitPlugins = has("--plugins");
// Run everything by default unless specific flags are provided
const migrateServers = !explicitSkills && !explicitPlugins || has("--servers");
const migrateSkills  = explicitSkills  || (!explicitPlugins && !has("--servers"));
const migratePlugins = explicitPlugins || (!explicitSkills  && !has("--servers"));

if (!fromArg) {
  console.error("Usage: migrate.mjs --from <cursor|claude|opencode|/path/to/file> [--out <path>] [--dry-run]");
  process.exit(1);
}

// ─── Servers migration ─────────────────────────────────────────────────────

if (migrateServers) {
  const SOURCES = {
    cursor:   resolve(homedir(), ".cursor", "mcp.json"),
    claude:   resolve(homedir(), ".claude.json"),
    opencode: resolve(homedir(), ".config", "opencode", "opencode.json"),
  };

  const sourcePath = SOURCES[fromArg] ?? resolve(fromArg);

  if (!existsSync(sourcePath)) {
    console.log(`\n⚠  Server config not found: ${sourcePath} — skipping servers migration.`);
  } else {
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
      console.log(`\n⚠  Unrecognized server config format in ${sourcePath} — skipping servers migration.`);
      mcpServers = null;
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

    if (mcpServers && Object.keys(mcpServers).length > 0) {
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
            description:  `Migrated from ${fromArg}`,
            keywords:     deriveKeywords(name, cfg),
            type:         "http",
            url:          cfg.url,
            ...(cfg.oauth  ? { oauth: cfg.oauth }   : {}),
            ...(cfg.headers ? { headers: cfg.headers } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
            autoActivate: false,
          };
        } else {
          converted[name] = {
            description:  `Migrated from ${fromArg}`,
            keywords:     deriveKeywords(name, cfg),
            command:      cfg.command,
            args:         cfg.args ?? [],
            ...(Object.keys(env).length > 0 ? { env } : {}),
            autoActivate: false,
          };
        }
      }

      const outPath = outArg ?? resolve(homedir(), ".config", "context-broker", "servers.json");
      let existing = { servers: {} };
      if (existsSync(outPath)) existing = JSON.parse(readFileSync(outPath, "utf-8"));
      const merged  = { servers: { ...existing.servers, ...converted } };
      const added   = Object.keys(converted).filter(k => !existing.servers[k]);
      const updated = Object.keys(converted).filter(k =>  existing.servers[k]);

      const zshenvPath = resolve(homedir(), ".zshenv");
      const zshenvExisting = existsSync(zshenvPath) ? readFileSync(zshenvPath, "utf-8") : "";
      const newSecrets = Object.entries(secretsToWrite)
        .filter(([k]) => !zshenvExisting.includes(`export ${k}=`));
      const zshenvBlock = newSecrets.length > 0
        ? `\n# MCP Broker secrets — migrated from ${fromArg} (${new Date().toISOString().slice(0,10)})\n` +
          newSecrets.map(([k, v]) => `export ${k}="${v}"`).join("\n") + "\n"
        : null;

      console.log(`\nSource:  ${sourcePath}`);
      console.log(`Output:  ${outPath}`);
      console.log(`Servers: ${Object.keys(mcpServers).length} found → ${Object.keys(converted).length} converted`);
      if (skipped.length)    console.log(`Skipped: ${skipped.join(", ")}`);
      if (added.length)      console.log(`Add:     ${added.join(", ")}`);
      if (updated.length)    console.log(`Update:  ${updated.join(", ")}`);
      if (newSecrets.length) console.log(`Secrets: ${newSecrets.map(([k]) => k).join(", ")} → ~/.zshenv`);
      else if (Object.keys(secretsToWrite).length > 0) console.log(`Secrets: all already present in ~/.zshenv`);

      if (dryRun) {
        console.log("\n--- servers.json (dry run) ---");
        console.log(JSON.stringify(merged, null, 2));
        if (zshenvBlock) { console.log("\n--- ~/.zshenv additions (dry run) ---"); console.log(zshenvBlock); }
        console.log(`--- Would remove from ${sourcePath}: ${Object.keys(converted).join(", ")} ---`);
      } else {
        mkdirSync(resolve(outPath, ".."), { recursive: true });
        writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
        console.log(`\n✓ Written: ${outPath}`);
        if (zshenvBlock) {
          writeFileSync(zshenvPath, zshenvExisting + zshenvBlock);
          console.log(`✓ Written: ${zshenvPath} (${newSecrets.length} secrets added)`);
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
  }
}

// ─── Skills migration ──────────────────────────────────────────────────────

if (migrateSkills) {
  const SKILLS_SOURCES = {
    claude:   resolve(homedir(), ".claude", "skills"),
    cursor:   resolve(homedir(), ".cursor", "skills"),
    opencode: resolve(homedir(), ".config", "opencode", "skills"),
  };

  const skillsDir = SKILLS_SOURCES[fromArg] ?? resolve(fromArg, "skills");
  const brokerSkillsDir = resolve(homedir(), ".config", "context-broker", "skills");

  if (!existsSync(skillsDir)) {
    console.log(`\n⚠  Skills directory not found: ${skillsDir} — skipping skills migration.`);
  } else {
    const skillsOutPath = skillsOutArg
      ?? resolve(homedir(), ".config", "context-broker", "skills.json");

    let existingSkills = { skills: {} };
    if (existsSync(skillsOutPath)) {
      existingSkills = JSON.parse(readFileSync(skillsOutPath, "utf-8"));
    }

    const convertedSkills = {};
    const skippedSkills = [];

    for (const entry of readdirSync(skillsDir)) {
      const srcDir = resolve(skillsDir, entry);
      const stat = statSync(srcDir);
      // skip non-directories and already-symlinked entries
      if (!stat.isDirectory()) continue;
      const skillPath = resolve(brokerSkillsDir, entry, "SKILL.md");
      const srcSkillPath = resolve(srcDir, "SKILL.md");
      if (!existsSync(srcSkillPath)) {
        skippedSkills.push(`${entry} (no SKILL.md)`);
        continue;
      }

      const content = readFileSync(srcSkillPath, "utf-8");
      const firstLine = content.split("\n").find(l => l.match(/^[A-Z]/)) ?? "";
      const description = firstLine.slice(0, 120) || `Skill: ${entry}`;

      const words = new Set();
      entry.toLowerCase().split(/[-_\s]+/).forEach(w => w.length > 2 && words.add(w));
      firstLine.toLowerCase().split(/\W+/).filter(w => w.length > 4).slice(0, 6).forEach(w => words.add(w));

      convertedSkills[entry] = {
        description,
        keywords: [...words],
        path: skillPath,
        migratedFrom: fromArg,
      };
    }

    const mergedSkills = { skills: { ...existingSkills.skills, ...convertedSkills } };
    const addedSkills   = Object.keys(convertedSkills).filter(k => !existingSkills.skills[k]);
    const updatedSkills = Object.keys(convertedSkills).filter(k =>  existingSkills.skills[k]);

    console.log(`\nSkills source: ${skillsDir}`);
    console.log(`Skills target: ${brokerSkillsDir}`);
    console.log(`Skills out:    ${skillsOutPath}`);
    if (addedSkills.length)   console.log(`Add:           ${addedSkills.join(", ")}`);
    if (updatedSkills.length) console.log(`Update:        ${updatedSkills.join(", ")}`);
    if (skippedSkills.length) console.log(`Skipped:       ${skippedSkills.join(", ")}`);

    if (dryRun) {
      console.log("\n--- skills.json (dry run) ---");
      console.log(JSON.stringify(mergedSkills, null, 2));
      console.log("--- (not written) ---");
    } else {
      mkdirSync(brokerSkillsDir, { recursive: true });
      mkdirSync(resolve(skillsOutPath, ".."), { recursive: true });

      let splitCount = 0;
      for (const entry of Object.keys(convertedSkills)) {
        const src = resolve(skillsDir, entry);
        const dst = resolve(brokerSkillsDir, entry);
        if (!existsSync(dst)) {
          renameSync(src, dst);               // move to broker dir
          symlinkSync(dst, src);              // leave symlink so /skill-name still works
          console.log(`✓ Moved:    ${src} → ${dst}`);
        } else {
          console.log(`  Exists:   ${dst} (skipped move)`);
        }

        // Split SKILL.md into frontmatter stub + INSTRUCTIONS.md
        const dstSkillPath = resolve(dst, "SKILL.md");
        const dstInstructions = resolve(dst, "INSTRUCTIONS.md");
        if (existsSync(dstSkillPath) && !existsSync(dstInstructions)) {
          const content = readFileSync(dstSkillPath, "utf-8");
          const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
          if (match) {
            const body = match[2].replace(/^\n+/, "");
            if (body) {
              writeFileSync(dstSkillPath, match[1]);
              writeFileSync(dstInstructions, body);
              splitCount++;
              console.log(`✓ Split:    ${dstSkillPath}`);
            }
          }
        }
      }
      if (splitCount > 0) console.log(`✓ Split ${splitCount} skill(s) into SKILL.md stub + INSTRUCTIONS.md`);

      writeFileSync(skillsOutPath, JSON.stringify(mergedSkills, null, 2) + "\n");
      console.log(`✓ Written: ${skillsOutPath}`);
    }
  }
}

// ─── Plugins migration ─────────────────────────────────────────────────────

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

    let existingSkills = { skills: {} };
    if (existsSync(skillsOutPath)) {
      existingSkills = JSON.parse(readFileSync(skillsOutPath, "utf-8"));
    }

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

    let splitCount = 0, registered = 0;
    const convertedPluginSkills = {};

    for (const skillPath of skillFiles) {
      const skillDir = dirname(skillPath);
      const skillName = basename(skillDir);
      const rel = relative(pluginsCache, skillDir).split("/");
      const pluginName = rel[1] ?? skillName;
      const registryKey = `${pluginName}:${skillName}`;
      const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");

      const content = readFileSync(skillPath, "utf-8");
      const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
      const fm = parseFrontmatter(content);
      const description = fm.description ?? `Skill: ${skillName}`;

      const words = new Set();
      skillName.toLowerCase().split(/[-_]+/).filter(w => w.length > 2).forEach(w => words.add(w));
      description.toLowerCase().split(/\W+/).filter(w => w.length > 4).forEach(w => words.add(w));
      const keywords = [...words].slice(0, 12);

      convertedPluginSkills[registryKey] = {
        description,
        keywords,
        path: skillPath,
        plugin: pluginName,
      };

      if (!dryRun && match) {
        const body = match[2].replace(/^\n+/, "");
        if (body && !existsSync(instructionsPath)) {
          writeFileSync(skillPath, match[1]);
          writeFileSync(instructionsPath, body);
          splitCount++;
        }
      }
      registered++;
    }

    const addedPluginSkills   = Object.keys(convertedPluginSkills).filter(k => !existingSkills.skills[k]);
    const updatedPluginSkills = Object.keys(convertedPluginSkills).filter(k =>  existingSkills.skills[k]);
    const mergedPluginSkills  = { skills: { ...existingSkills.skills, ...convertedPluginSkills } };

    console.log(`\nPlugins cache: ${pluginsCache}`);
    console.log(`Skills out:    ${skillsOutPath}`);
    console.log(`Skills found:  ${skillFiles.length}`);
    if (addedPluginSkills.length)   console.log(`Add:           ${addedPluginSkills.length} skills`);
    if (updatedPluginSkills.length) console.log(`Update:        ${updatedPluginSkills.length} skills`);

    if (dryRun) {
      console.log("\n--- skills.json plugin entries (dry run) ---");
      console.log(JSON.stringify(convertedPluginSkills, null, 2));
      console.log("--- (not written) ---");
    } else {
      mkdirSync(resolve(skillsOutPath, ".."), { recursive: true });
      writeFileSync(skillsOutPath, JSON.stringify(mergedPluginSkills, null, 2) + "\n");
      console.log(`✓ Split:   ${splitCount} SKILL.md files`);
      console.log(`✓ Written: ${skillsOutPath}`);

      // Install split-skills.mjs into ~/.config/context-broker/scripts/
      const scriptsSrc = resolve(__dirname, "split-skills.mjs");
      const scriptsDst = resolve(homedir(), ".config", "context-broker", "scripts", "split-skills.mjs");
      mkdirSync(dirname(scriptsDst), { recursive: true });
      copyFileSync(scriptsSrc, scriptsDst);
      console.log(`✓ Installed: ${scriptsDst}`);

      // Add SessionStart hook to keep plugin splits fresh after plugin updates
      const settingsPath = resolve(homedir(), ".claude", "settings.json");
      const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      const hookCmd = "node ~/.config/context-broker/scripts/split-skills.mjs";
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
