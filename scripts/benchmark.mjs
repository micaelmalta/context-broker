#!/usr/bin/env node
// Benchmarks token usage and latency across MCP tool-loading strategies
// using the Claude CLI (`claude -p --output-format json`).
//
// Strategies:
//   baseline  — no MCP servers at all (pure system prompt cost)
//   direct    — all servers loaded upfront every request (current worst case)
//   broker    — only 4 meta-tools visible; servers loaded on demand
//   activated — broker + all servers loaded (broker worst case)
//
// Usage:
//   node scripts/benchmark.mjs
//   node scripts/benchmark.mjs --config ~/.config/context-broker/servers.json
//   node scripts/benchmark.mjs --servers fetch-mcp,jira
//   node scripts/benchmark.mjs --rounds 3

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

// ─── CLI args ──────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const get    = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const configArg  = get("--config");
const serverArg  = get("--servers");
const roundsArg  = parseInt(get("--rounds") ?? "1", 10);

// ─── Config ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveConfig() {
  if (configArg) return resolve(configArg);
  const xdg = resolve(homedir(), ".config", "context-broker", "servers.json");
  if (existsSync(xdg)) return xdg;
  return resolve(__dirname, "../config/servers.json");
}

const configPath = resolveConfig();
const { servers: allServers } = JSON.parse(readFileSync(configPath, "utf-8"));

const subset = serverArg ? new Set(serverArg.split(",").map(s => s.trim())) : null;
const servers = Object.fromEntries(
  Object.entries(allServers).filter(([name]) => !subset || subset.has(name))
);

if (Object.keys(servers).length === 0) {
  console.error("No servers to benchmark.");
  process.exit(1);
}

// ─── Broker meta-tool definitions ─────────────────────────────────────────

const BROKER_META_TOOLS = [
  { name: "discover_tools",     description: "Find which tool servers are available and relevant for a task. Call this first when you need a capability you don't have yet.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "activate_server",    description: "Load and connect a tool server, making its tools available. Call discover_tools first to find the right server name.", inputSchema: { type: "object", properties: { server_name: { type: "string" } }, required: ["server_name"] } },
  { name: "deactivate_server",  description: "Shut down a tool server to free resources.", inputSchema: { type: "object", properties: { server_name: { type: "string" } }, required: ["server_name"] } },
  { name: "list_active_servers", description: "Show which servers are currently active and their tools.", inputSchema: { type: "object", properties: {} } },
];

function makeFakeMcpScript() {
  return `
const tools = JSON.parse(process.argv[process.argv.length - 1]);
let buf = "";
process.stdin.on("data", c => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      let resp;
      if (msg.method === "initialize") {
        resp = { jsonrpc:"2.0", id:msg.id, result:{ protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"fake",version:"1.0"} } };
      } else if (msg.method === "tools/list") {
        resp = { jsonrpc:"2.0", id:msg.id, result:{ tools } };
      } else if (msg.id != null) {
        resp = { jsonrpc:"2.0", id:msg.id, result:{} };
      }
      if (resp) process.stdout.write(JSON.stringify(resp) + "\\n");
    } catch {}
  }
});
`.trim();
}

function buildMcpConfig(serverNames, extras = []) {
  const mcpServers = {};
  for (const name of serverNames) {
    const cfg = servers[name];
    if (!cfg || !cfg.command) continue;
    const env = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      env[k] = v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "");
    }
    mcpServers[name] = {
      command: cfg.command,
      args: cfg.args ?? [],
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  for (const { name, tools } of extras) {
    mcpServers[name] = {
      command: "node",
      args: ["-e", makeFakeMcpScript(), "--", JSON.stringify(tools)],
    };
  }
  return { mcpServers };
}

// ─── Run one claude -p measurement ────────────────────────────────────────

const PROMPT = "Say only: ok";

async function runClaude(mcpConfig, extraArgs = []) {
  const hasMcpServers = Object.keys(mcpConfig.mcpServers ?? {}).length > 0;
  const claudeArgs = [
    "-p", PROMPT,
    "--output-format", "json",
    "--tools", "",
    "--no-session-persistence",
    ...(hasMcpServers ? ["--mcp-config", JSON.stringify(mcpConfig)] : []),
    "--bare",
    ...extraArgs,
  ];

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync("claude", claudeArgs, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const wallMs = Date.now() - start;
    const data = JSON.parse(stdout.trim());
    const u = data.usage ?? {};
    const totalInput = (u.input_tokens ?? 0)
      + (u.cache_creation_input_tokens ?? 0)
      + (u.cache_read_input_tokens ?? 0);
    return {
      ok: true,
      inputTokens:  u.input_tokens ?? 0,
      cacheCreate:  u.cache_creation_input_tokens ?? 0,
      cacheRead:    u.cache_read_input_tokens ?? 0,
      totalInput,
      outputTokens: u.output_tokens ?? 0,
      durationMs:   data.duration_ms ?? wallMs,
      costUSD:      data.total_cost_usd ?? 0,
    };
  } catch (err) {
    console.warn(`  ⚠  claude CLI error: ${err.message?.slice(0, 120)}`);
    return { ok: false, inputTokens: 0, cacheCreate: 0, cacheRead: 0, totalInput: 0, outputTokens: 0, durationMs: Date.now() - start, costUSD: 0 };
  }
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

async function measure(label, description, mcpConfig, rounds, extraArgs = []) {
  process.stdout.write(`  ${label.padEnd(12)} ${description}\n`);
  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (rounds > 1) process.stdout.write(`               round ${i + 1}/${rounds}...\r`);
    results.push(await runClaude(mcpConfig, extraArgs));
  }
  if (rounds > 1) process.stdout.write(" ".repeat(40) + "\r");

  const ok = results.filter(r => r.ok);
  if (ok.length === 0) return { label, description, ok: false, totalInput: 0, inputTokens: 0, cacheCreate: 0, cacheRead: 0, outputTokens: 0, durationMs: 0, costUSD: 0 };

  const result = {
    label, description, ok: true, rounds: ok.length,
    totalInput:   Math.round(mean(ok.map(r => r.totalInput))),
    inputTokens:  Math.round(mean(ok.map(r => r.inputTokens))),
    cacheCreate:  Math.round(mean(ok.map(r => r.cacheCreate))),
    cacheRead:    Math.round(mean(ok.map(r => r.cacheRead))),
    outputTokens: Math.round(mean(ok.map(r => r.outputTokens))),
    durationMs:   Math.round(mean(ok.map(r => r.durationMs))),
    costUSD:      mean(ok.map(r => r.costUSD)),
  };
  process.stdout.write(`               ${result.totalInput.toLocaleString()} tokens  ${result.durationMs.toLocaleString()}ms\n`);
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const serverNames = Object.keys(servers);
const n = serverNames.length;

console.log(`\nMCP Broker Benchmark`);
console.log(`${"─".repeat(60)}`);
console.log(`Config:  ${configPath}`);
console.log(`Servers: ${n}  (${serverNames.join(", ")})`);
console.log(`Rounds:  ${roundsArg}`);
console.log(`Prompt:  "${PROMPT}"\n`);
console.log(`Running strategies...\n`);

const empty       = buildMcpConfig([]);
const direct      = buildMcpConfig(serverNames);
const brokerIdle  = buildMcpConfig([], [{ name: "broker", tools: BROKER_META_TOOLS }]);
const brokerFull  = buildMcpConfig(serverNames, [{ name: "broker", tools: BROKER_META_TOOLS }]);

const baseline  = await measure("baseline",  "no MCP servers (pure system prompt)",              empty,      roundsArg, ["--disable-slash-commands"]);
const direct_r  = await measure("direct",    `all ${n} servers loaded upfront`,                  direct,     roundsArg);
const broker_r  = await measure("broker",    "4 meta-tools only (idle)",                         brokerIdle, roundsArg);
const activated = await measure("activated", `4 meta-tools + all ${n} servers (worst case)`,     brokerFull, roundsArg);

// ─── Report ────────────────────────────────────────────────────────────────

const rows = [baseline, direct_r, broker_r, activated];
const ok   = rows.filter(r => r.ok);

if (ok.length === 0) { console.error("All strategies failed."); process.exit(1); }

const W = 72;
const colL = (s, w) => String(s).padEnd(w);
const colR = (s, w) => String(s).padStart(w);
const fmt  = (n) => n.toLocaleString();

console.log(`\n${"═".repeat(W)}`);
console.log(`RESULTS  (${roundsArg} round${roundsArg !== 1 ? "s" : ""} each)`);
console.log(`${"═".repeat(W)}\n`);

// ── Savings summary ────────────────────────────────────────────────────────
if (baseline.ok && direct_r.ok && broker_r.ok) {
  const sysPrompt   = baseline.totalInput;
  const directMCP   = direct_r.totalInput - sysPrompt;
  const brokerMCP   = broker_r.totalInput - sysPrompt;
  const savedTokens = direct_r.totalInput - broker_r.totalInput;
  const savedPct    = (savedTokens / direct_r.totalInput * 100).toFixed(1);
  const savedCost   = direct_r.costUSD - broker_r.costUSD;
  const saved1k     = savedCost * 1000;

  console.log(`  Without broker   ${fmt(directMCP)} tokens of MCP schema injected per request`);
  console.log(`  With broker      ${fmt(brokerMCP)} tokens              (${savedPct}% less, −${fmt(savedTokens)} tokens/req)`);
  console.log(`  Cost saving      $${savedCost.toFixed(5)} per request   ≈ $${saved1k.toFixed(2)} per 1,000 requests`);
  console.log();
}

// ── Per-strategy table ─────────────────────────────────────────────────────
console.log(`${colL("Strategy", 14)} ${colR("Tokens", 10)} ${colR("Token cost", 12)} ${colR("vs direct", 12)} ${colR("Latency", 9)}`);
console.log(`${"─".repeat(W)}`);
for (const r of rows) {
  if (!r.ok) { console.log(`${colL(r.label, 14)} ${"ERROR".padStart(10)}`); continue; }
  const vsDir = (r.label === "direct" || r.label === "baseline")
    ? ""
    : (() => {
        if (!direct_r.ok) return "—";
        const saved = direct_r.totalInput - r.totalInput;
        return saved > 0 ? `−${fmt(saved)}` : `+${fmt(-saved)}`;
      })();
  console.log(`${colL(r.label, 14)} ${colR(fmt(r.totalInput), 10)} ${colR("$" + r.costUSD.toFixed(5), 12)} ${colR(vsDir, 12)} ${colR(fmt(r.durationMs) + "ms", 9)}`);
}
console.log(`${"─".repeat(W)}`);
console.log(`  baseline = no MCP at all  |  activated = broker + all servers loaded`);

// ── Cache breakdown ────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(W)}`);
console.log(`CACHE BREAKDOWN\n`);
console.log(`${colL("Strategy", 14)} ${colR("uncached", 10)} ${colR("cache write", 13)} ${colR("cache read", 12)} ${colR("total", 8)}`);
console.log(`${"─".repeat(W)}`);
for (const r of ok) {
  console.log(`${colL(r.label, 14)} ${colR(fmt(r.inputTokens), 10)} ${colR(fmt(r.cacheCreate), 13)} ${colR(fmt(r.cacheRead), 12)} ${colR(fmt(r.totalInput), 8)}`);
}

console.log(`\n${"─".repeat(W)}\n`);
