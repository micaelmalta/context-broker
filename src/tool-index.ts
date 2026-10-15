// src/tool-index.ts
// Persistent index of each server's tool names/descriptions, learned on first activation.
// Lets discover_tools route by what a server's tools actually do — including for servers
// whose configured description is generic (e.g. migrated ones) and that are not running.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { ServerConfig } from "./router.js";
import { LOG_PREFIX } from "./version.js";

export interface IndexedTool {
  name: string;
  description: string;
}

interface Entry {
  /** Hash of the spawn/connect inputs; a changed server invalidates its index. */
  sig: string;
  tools: IndexedTool[];
}

const MAX_TOOLS_PER_SERVER = 200;
const MAX_DESCRIPTION_CHARS = 200;

export function serverSignature(cfg: ServerConfig): string {
  return JSON.stringify([cfg.command ?? null, cfg.args ?? [], cfg.url ?? null]);
}

/** Searchable text for one server: tool names (split on _ and -) plus descriptions. */
export function toolText(tools: IndexedTool[]): string {
  return tools
    .map((t) => `${t.name.replace(/[_-]+/g, " ")} ${t.description}`)
    .join(" ");
}

export class ToolIndex {
  private data: Record<string, Entry> = {};

  /** @param path JSON file to persist to; omit for a purely in-memory index. */
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Entry>;
        if (raw && typeof raw === "object") this.data = raw;
      } catch {
        /* corrupt cache — rebuilt as servers are activated */
      }
    }
  }

  /** Indexed tools for a server, or [] if unknown or stale (config changed). */
  get(name: string, cfg: ServerConfig): IndexedTool[] {
    const e = this.data[name];
    return e && e.sig === serverSignature(cfg) ? e.tools : [];
  }

  /** Remember a server's tools. Returns true when the stored index changed. */
  record(name: string, cfg: ServerConfig, tools: Array<{ name: string; description?: string }>): boolean {
    const entry: Entry = {
      sig: serverSignature(cfg),
      tools: tools.slice(0, MAX_TOOLS_PER_SERVER).map((t) => ({
        name: t.name,
        description: (t.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
      })),
    };
    if (JSON.stringify(this.data[name]) === JSON.stringify(entry)) return false;
    this.data[name] = entry;
    this.save();
    return true;
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
      renameSync(tmp, this.path);
    } catch (err) {
      console.error(`${LOG_PREFIX} could not write tool index: ${(err as Error).message}`);
    }
  }
}
