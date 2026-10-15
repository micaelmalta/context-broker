// src/paths.ts
// App name, config directory and the one-time adoption of the pre-rename directory.

import { existsSync, lstatSync, renameSync, symlinkSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { LOG_PREFIX } from "./version.js";

export const APP_NAME = "lazygate";
/** The project's previous name; its config directory and client entries are still recognised. */
export const LEGACY_APP_NAME = "context-broker";

export function configDir(home: string = homedir()): string {
  return resolve(home, ".config", APP_NAME);
}

/**
 * Move ~/.config/context-broker to ~/.config/lazygate once, leaving a symlink behind so
 * hooks and scripts that still use the old path keep working. Never throws.
 * Returns true when a move happened.
 */
export function adoptLegacyConfigDir(home: string = homedir()): boolean {
  const next = configDir(home);
  const legacy = resolve(home, ".config", LEGACY_APP_NAME);
  try {
    if (existsSync(next)) return false;
    const st = lstatSync(legacy, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return false; // missing, or already a symlink
    renameSync(legacy, next);
    try {
      symlinkSync(next, legacy, "dir");
    } catch {
      /* best effort (e.g. no symlink permission on Windows) */
    }
    console.error(`${LOG_PREFIX} Moved config ${legacy} → ${next}`);
    return true;
  } catch (err) {
    console.error(`${LOG_PREFIX} Could not move legacy config dir: ${(err as Error).message}`);
    return false;
  }
}
