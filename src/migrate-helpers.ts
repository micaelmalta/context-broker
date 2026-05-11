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

export function detectShellSecretFile(): ShellSecretFile {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("fish")) {
    const filePath = resolve(homedir(), ".config", "fish", "config.fish");
    return {
      path: filePath,
      format: (k, v) => `set -gx ${k} "${v}"`,
      checkExisting: (content, k) =>
        content.includes(`set -gx ${k} `) || content.includes(`set -Ux ${k} `),
      label: "~/.config/fish/config.fish",
    };
  }
  const filePath = resolve(homedir(), ".zshenv");
  return {
    path: filePath,
    format: (k, v) => `export ${k}="${v}"`,
    checkExisting: (content, k) => content.includes(`export ${k}=`),
    label: "~/.zshenv",
  };
}

export function resolveBrokerEntry(distDir: string): BrokerEntry {
  try {
    const bin = execSync("which context-broker 2>/dev/null", { encoding: "utf-8" }).trim();
    if (bin) return { command: bin, args: [] };
  } catch { /* not installed globally */ }

  const distPath = resolve(distDir, "index.js");
  if (existsSync(distPath)) return { command: "node", args: [distPath] };

  console.warn(
    "  ⚠  context-broker binary not found — using npx fallback. " +
    "Run `npm install -g context-broker` for a stable install."
  );
  return { command: "npx", args: ["-y", "context-broker"] };
}
