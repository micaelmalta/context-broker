// src/version.ts
// Single source of truth for the package version (read from package.json).

import { readFileSync } from "fs";

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
export const LOG_PREFIX = "[lazygate]";
