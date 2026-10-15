// Shared helpers for migrate.mjs, revert-migration.mjs and session-sync.mjs.
// Plain ESM, no build step. session-sync.mjs is copied to
// ~/.config/lazygate/scripts/ together with this file (scripts/lib/shared.mjs).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
  lstatSync,
  copyFileSync,
  statSync,
  realpathSync,
  unlinkSync,
} from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";

// ─── App identity and config directory ──────────────────────────────────────

export const APP_NAME = "lazygate";
/** Previous project name — its config dir, client entries, stub markers and hook are still recognised. */
export const LEGACY_APP_NAME = "context-broker";
/** Every name the broker may be registered under in a client config. */
export const BROKER_NAMES = [APP_NAME, LEGACY_APP_NAME];

/**
 * The config directory to use right now: ~/.config/lazygate, or the old
 * ~/.config/context-broker when only that exists (e.g. --dry-run before adoption).
 */
export function activeConfigDir(home = homedir()) {
  const next = resolve(home, ".config", APP_NAME);
  const legacy = resolve(home, ".config", LEGACY_APP_NAME);
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
}

/**
 * Move ~/.config/context-broker to ~/.config/lazygate once, leaving a symlink so hooks and
 * scripts that still use the old path keep working. Never throws; returns true when moved.
 */
export function adoptLegacyConfigDir(home = homedir()) {
  const next = resolve(home, ".config", APP_NAME);
  const legacy = resolve(home, ".config", LEGACY_APP_NAME);
  try {
    if (existsSync(next)) return false;
    const st = lstatSync(legacy, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return false;
    renameSync(legacy, next);
    try { symlinkSync(next, legacy, "dir"); } catch { /* best effort */ }
    console.error(`[${APP_NAME}] Moved config ${legacy} → ${next}`);
    return true;
  } catch (err) {
    console.error(`[${APP_NAME}] Could not move legacy config dir: ${err.message}`);
    return false;
  }
}

/** Remove every broker registration (current and legacy name) from a client's server map. Returns true if any was removed. */
export function removeBrokerEntries(servers) {
  let removed = false;
  for (const n of BROKER_NAMES) {
    if (servers && servers[n]) { delete servers[n]; removed = true; }
  }
  return removed;
}

// ─── Safe file writes ───────────────────────────────────────────────────────

const backedUp = new Set();

/** Copy `path` to `path.bak-<timestamp>` once per process. Returns the backup path or null. */
export function backupFile(path) {
  if (!existsSync(path) || backedUp.has(path)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.bak-${ts}`;
  copyFileSync(path, dest);
  backedUp.add(path);
  return dest;
}

/** Write via temp file + rename so readers never observe a half-written file. */
export function writeFileAtomic(path, data) {
  const target = existsSync(path) ? realpathSync(path) : path; // keep symlinks intact
  mkdirSync(dirname(target), { recursive: true });
  let mode;
  try { mode = statSync(target).mode & 0o777; } catch { /* new file */ }
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  renameSync(tmp, target);
}

export function readJsonFile(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Could not parse ${path}: ${err.message}`);
  }
}

/**
 * Pretty-print JSON to `path` atomically, backing the old file up first.
 * Returns false (and touches nothing) when the content would not change.
 */
export function writeJsonSafe(path, obj, { backup = true } = {}) {
  const next = JSON.stringify(obj, null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf-8") === next) return false;
  if (backup) backupFile(path);
  writeFileAtomic(path, next);
  return true;
}

// ─── File discovery (portable replacement for `find`) ───────────────────────

/**
 * Walk `root` (not following symlinks) like `find root -name <name> -maxdepth N`.
 * type: "file" | "dir".
 */
export function findFiles(root, { name, type = "file", maxDepth = 10 }) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      const isDir = e.isDirectory();
      if (e.name === name && (type === "dir" ? isDir : e.isFile())) out.push(full);
      if (isDir && depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

// ─── Frontmatter / registry entries ─────────────────────────────────────────

export const STUB_MARKER = `<!-- ${APP_NAME}:`;
/** Stubs written before the rename carry the old marker; they are still recognised. */
export const STUB_MARKERS = [STUB_MARKER, `<!-- ${LEGACY_APP_NAME}:`];
const findStubMarker = (text) => {
  const hits = STUB_MARKERS.map((m) => text.indexOf(m)).filter((i) => i !== -1);
  return hits.length ? Math.min(...hits) : -1;
};

export function parseFrontmatter(text) {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split("\n");
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (/^[|>][+-]?$/.test(val) || val === "") {
      // block scalar (| or >) or plain multi-line value: join indented continuation lines
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        parts.push(lines[++i].trim());
      }
      val = parts.filter(Boolean).join(" ");
    }
    const q = val.match(/^(["'])([\s\S]*)\1$/);
    result[key] = q ? q[2] : val;
  }
  return result;
}

function stripFrontmatter(text) {
  return text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * Registry entry for a SKILL.md (or command .md). One implementation for every
 * script so the same skill always gets the same description and keywords.
 */
export function deriveEntry(key, filePath, extra = {}, { command = false } = {}) {
  const content = readFileSync(filePath, "utf-8");
  const fm = parseFrontmatter(content);

  // After a split, the prose lives in INSTRUCTIONS.md.
  let prose = content;
  const instr = filePath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  if (instr !== filePath && existsSync(instr)) prose = readFileSync(instr, "utf-8");

  const firstLine = stripFrontmatter(prose)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^[#A-Za-z]/.test(l) && !STUB_MARKERS.some((m) => l.startsWith(m))) ?? "";

  const description =
    (fm.description || firstLine.replace(/^#+\s*/, "")).slice(0, 120) ||
    `${command ? "Command" : "Skill"}: ${key}`;

  const words = new Set();
  key.toLowerCase().split(/[-_/\s:@]+/).filter((w) => w.length > 2).forEach((w) => words.add(w));
  description.toLowerCase().split(/\W+/).filter((w) => w.length > 4).slice(0, 8).forEach((w) => words.add(w));

  return { description, keywords: [...words].slice(0, 12), path: filePath, ...extra };
}

/** Pick a registry key that does not clobber a different skill with the same name. */
export function uniqueSkillKey(skills, key, filePath, label) {
  const cur = skills[key];
  if (!cur || cur.path === filePath) return key;
  let alt = `${key}@${label}`;
  let n = 2;
  while (skills[alt] && skills[alt].path !== filePath) alt = `${key}@${label}-${n++}`;
  return alt;
}

// ─── SKILL.md split / merge ─────────────────────────────────────────────────

/**
 * Split SKILL.md into a frontmatter stub + INSTRUCTIONS.md (in place).
 * The stub keeps a one-line pointer so harnesses that read SKILL.md directly
 * still learn where the instructions are. Returns true if a split happened.
 */
export function splitSkillMd(skillPath, key) {
  if (!existsSync(skillPath)) return false;
  const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  if (instructionsPath === skillPath || existsSync(instructionsPath)) return false;

  const content = readFileSync(skillPath, "utf-8");
  if (findStubMarker(content) !== -1) return false; // already a stub
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) return false;
  const body = match[2].replace(/^\n+/, "");
  if (!body.trim()) return false;

  const pointer =
    `${STUB_MARKER} full instructions are in INSTRUCTIONS.md next to this file; ` +
    `load them with the lazygate load_skill tool${key ? ` ("${key}")` : ""} -->\n`;

  writeFileAtomic(instructionsPath, body);
  writeFileAtomic(skillPath, match[1] + "\n" + pointer);
  return true;
}

/** Inverse of splitSkillMd. Returns true if INSTRUCTIONS.md was merged back. */
export function mergeInstructions(skillPath) {
  const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  if (instructionsPath === skillPath) return false;
  if (!existsSync(instructionsPath) || !existsSync(skillPath)) return false;

  const stub = readFileSync(skillPath, "utf-8");
  const body = readFileSync(instructionsPath, "utf-8");
  const idx = findStubMarker(stub);
  const head = (idx === -1 ? stub : stub.slice(0, idx)).replace(/\s+$/, "");
  writeFileAtomic(skillPath, head + "\n\n" + body);
  unlinkSync(instructionsPath);
  return true;
}

// ─── Client-specific variable syntax ────────────────────────────────────────

/** Cursor writes `${env:VAR}`; the broker uses `${VAR}`. */
export const fromCursorVars = (s) =>
  typeof s === "string" ? s.replace(/\$\{env:(\w+)\}/g, "${$1}") : s;
export const toCursorVars = (s) =>
  typeof s === "string" ? s.replace(/\$\{(\w+)\}/g, "${env:$1}") : s;

export function mapStrings(value, fn) {
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return fn(value);
}
