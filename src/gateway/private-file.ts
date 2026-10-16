// src/gateway/private-file.ts
// Small helpers for gateway state files: 0700 directories, 0600 files, atomic writes.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";

export function writePrivateJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Read JSON; returns `fallback` for a missing or unreadable file. Warns when the file is group/world accessible. */
export function readPrivateJson<T>(path: string, fallback: T, label: string): T {
  if (!existsSync(path)) return fallback;
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      console.error(`[lazygate] warning: ${label} (${path}) is accessible by other users — run: chmod 600 ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    console.error(`[lazygate] could not read ${label} (${path}): ${(err as Error).message}`);
    return fallback;
  }
}

export function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function ensurePrivateMode(path: string): void {
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}
