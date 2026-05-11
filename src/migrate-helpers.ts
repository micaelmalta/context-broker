import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

export interface ShellSecretFile {
  path: string;
  format: (key: string, value: string) => string;
  checkExisting: (content: string, key: string) => boolean;
  label: string;
}

export interface BrokerEntry {
  command: string;
  args: string[];
}

function escapeRegexKey(k: string): string {
  return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeFish(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function escapeShell(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

export function detectShellSecretFile(): ShellSecretFile {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("fish")) {
    const filePath = resolve(homedir(), ".config", "fish", "config.fish");
    return {
      path: filePath,
      format: (k, v) => `set -gx ${k} "${escapeFish(v)}"`,
      checkExisting: (content, k) =>
        new RegExp(`^\\s*set\\s+-[gUx]+\\s+${escapeRegexKey(k)}(\\s|$)`, "m").test(content),
      label: "~/.config/fish/config.fish",
    };
  }
  const isBash = shell.endsWith("bash");
  const filePath = resolve(homedir(), isBash ? ".bashrc" : ".zshenv");
  return {
    path: filePath,
    format: (k, v) => `export ${k}="${escapeShell(v)}"`,
    checkExisting: (content, k) =>
      new RegExp(`^\\s*export\\s+${escapeRegexKey(k)}=`, "m").test(content),
    label: isBash ? "~/.bashrc" : "~/.zshenv",
  };
}

export function resolveBrokerEntry(distDir: string): BrokerEntry {
  try {
    const bin = execSync("command -v context-broker 2>/dev/null", { encoding: "utf-8" }).trim();
    // Reject npx shims — check path components for node_modules or _npx
    const binParts = bin.split(/[\\/]/);
    if (bin && !binParts.includes("node_modules") && !binParts.includes("_npx")) {
      return { command: bin, args: [] };
    }
  } catch { /* not installed globally */ }

  const distPath = resolve(distDir, "index.js");
  if (existsSync(distPath) && !distDir.split(/[\\/]/).includes("node_modules")) {
    return { command: "node", args: [distPath] };
  }

  console.warn(
    "  ⚠  context-broker binary not found — using npx fallback. " +
    "Run `npm install -g context-broker` for a stable install."
  );
  return { command: "npx", args: ["-y", "context-broker"] };
}
