// src/registry.ts
// Loads the server and skill registries (shared by stdio mode and the HTTP gateway).

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ToolRouter, type ServerConfig } from "./router.js";
import { SkillRouter } from "./skill-router.js";
import { ToolIndex } from "./tool-index.js";
import { parseServersConfig, parseSkillsConfig, reportConfigErrors } from "./config.js";
import { configDir } from "./paths.js";
import { LOG_PREFIX } from "./version.js";

export interface Registry {
  router: ToolRouter;
  skillRouter: SkillRouter | null;
  toolIndex: ToolIndex;
  serverConfigs: Record<string, ServerConfig>;
  configPath: string | null;
}

/**
 * Resolution: --<flag> <path> → ~/.config/lazygate/<file>.
 * The bundled config/ directory only holds *examples* and is never loaded implicitly.
 */
function resolveConfigPath(argv: string[], flag: string, file: string, dir: string): string | null {
  const flagIdx = argv.indexOf(flag);
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const p = resolve(argv[flagIdx + 1]);
    if (!existsSync(p)) throw new Error(`Config file not found: ${p}`);
    return p;
  }
  const xdg = resolve(dir, file);
  return existsSync(xdg) ? xdg : null;
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

export function loadRegistry(argv: string[], dir: string = configDir()): Registry {
  const configPath = resolveConfigPath(argv, "--config", "servers.json", dir);
  let serverConfigs: Record<string, ServerConfig> = {};
  if (configPath) {
    const { entries, errors } = parseServersConfig(loadJson(configPath), configPath);
    serverConfigs = entries;
    reportConfigErrors(errors);
    console.error(`${LOG_PREFIX} Config: ${configPath} (${Object.keys(entries).length} servers)`);
  } else {
    console.error(
      `${LOG_PREFIX} No servers.json found. Create ~/.config/lazygate/servers.json ` +
        `(see config/servers.json in the repo for an example) or pass --config <path>. ` +
        `Starting with an empty registry.`
    );
  }

  const toolIndex = new ToolIndex(resolve(dir, "tool-index.json"));
  const router = new ToolRouter(serverConfigs, configPath ?? undefined, toolIndex);

  const skillsConfigPath = resolveConfigPath(argv, "--skills", "skills.json", dir);
  let skillRouter: SkillRouter | null = null;
  if (skillsConfigPath) {
    try {
      const { entries, errors } = parseSkillsConfig(loadJson(skillsConfigPath), skillsConfigPath);
      reportConfigErrors(errors);
      skillRouter = new SkillRouter(entries, skillsConfigPath);
      console.error(`${LOG_PREFIX} Skills config: ${skillsConfigPath} (${Object.keys(entries).length} skills)`);
    } catch (err) {
      // A half-written skills.json must not stop startup; it is re-read lazily.
      console.error(`${LOG_PREFIX} ${(err as Error).message} — will retry on first use`);
      skillRouter = new SkillRouter({}, skillsConfigPath);
    }
  }

  return { router, skillRouter, toolIndex, serverConfigs, configPath };
}
