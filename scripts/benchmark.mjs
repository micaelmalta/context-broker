#!/usr/bin/env node
// Benchmarks token usage and latency across three tool-loading strategies
// using the Claude CLI (`claude -p --output-format json`).
//
// Strategies:
//   1. Direct       — all server schemas loaded upfront every request
//   2. Broker idle  — only 4 broker meta-tools visible to Claude
//   3. Broker worst — broker meta-tools + all servers activated (max overhead)
//
// Usage:
//   node scripts/benchmark.mjs
//   node scripts/benchmark.mjs --config ~/.config/mcp-broker/servers.json
//   node scripts/benchmark.mjs --servers fetch-mcp,jira
//   node scripts/benchmark.mjs --rounds 3   (repeat each strategy N times, report mean)

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const configArg = get("--config");
const serverArg = get("--servers");
const roundsArg = parseInt(get("--rounds") ?? "1", 10);

// ─── Config ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveConfig() {
  if (configArg) return resolve(configArg);
  const xdg = resolve(homedir(), ".config", "mcp-broker", "servers.json");
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

// ─── Broker meta-tool definitions (static fake MCP server) ────────────────
// We expose them as a fake MCP server using `node -e` that speaks JSON-RPC
// and returns exactly these 4 tools.

const BROKER_META_TOOLS = [
  { name: "discover_tools",     description: "Find which tool servers are available and relevant for a task. Call this first when you need a capability you don't have yet.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "activate_server",    description: "Load and connect a tool server, making its tools available. Call discover_tools first to find the right server name.", inputSchema: { type: "object", properties: { server_name: { type: "string" } }, required: ["server_name"] } },
  { name: "deactivate_server",  description: "Shut down a tool server to free resources.", inputSchema: { type: "object", properties: { server_name: { type: "string" } }, required: ["server_name"] } },
  { name: "list_active_servers", description: "Show which servers are currently active and their tools.", inputSchema: { type: "object", properties: {} } },
];

// Inline Node.js MCP server that serves a static tool list via JSON-RPC stdio.
// Passed as: node -e "<script>" -- '<json>'
// eslint-disable-next-line no-unused-vars
function makeFakeMcpScript(_tools) {
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

// Build --mcp-config JSON for a given set of named server configs + optional extras.
// Each entry maps to a real server definition from servers.json.
// `extras` is an array of { name, tools } to add as fake MCP servers.
function buildMcpConfig(serverNames, extras = []) {
  const mcpServers = {};

  for (const name of serverNames) {
    const cfg = servers[name];
    if (!cfg) continue;
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
      args: ["-e", makeFakeMcpScript(tools), "--", JSON.stringify(tools)],
    };
  }

  return { mcpServers };
}

// ─── Run one claude -p measurement ────────────────────────────────────────

const PROMPT = "Say only: ok";

async function runClaude(mcpConfig, label) {
  const mcpConfigStr = JSON.stringify(mcpConfig);

  const claudeArgs = [
    "-p", PROMPT,
    "--output-format", "json",
    "--tools", "",                   // disable built-in tools so only MCP tools count
    "--no-session-persistence",
    "--mcp-config", mcpConfigStr,
    "--bare",                        // skip hooks, CLAUDE.md, memory, plugins
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
    // Total tokens that count against the context window = all input-side tokens
    const totalInput = (u.input_tokens ?? 0)
      + (u.cache_creation_input_tokens ?? 0)
      + (u.cache_read_input_tokens ?? 0);

    return {
      label,
      ok: true,
      inputTokens: u.input_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      totalInput,
      outputTokens: u.output_tokens ?? 0,
      durationMs: data.duration_ms ?? wallMs,
      wallMs,
      costUSD: data.total_cost_usd ?? 0,
    };
  } catch (err) {
    const wallMs = Date.now() - start;
    console.warn(`  ⚠  claude CLI error for "${label}": ${err.message?.slice(0, 120)}`);
    return { label, ok: false, inputTokens: 0, cacheCreate: 0, cacheRead: 0, totalInput: 0, outputTokens: 0, durationMs: wallMs, wallMs, costUSD: 0 };
  }
}

// ─── Aggregate multiple rounds ─────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

async function measureStrategy(label, mcpConfig, rounds) {
  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (rounds > 1) process.stdout.write(`    round ${i + 1}/${rounds}...\n`);
    results.push(await runClaude(mcpConfig, label));
  }
  const ok = results.filter(r => r.ok);
  if (ok.length === 0) return { label, ok: false, totalInput: 0, durationMs: 0, costUSD: 0, rounds: 0 };

  return {
    label,
    ok: true,
    rounds: ok.length,
    totalInput:   Math.round(mean(ok.map(r => r.totalInput))),
    inputTokens:  Math.round(mean(ok.map(r => r.inputTokens))),
    cacheCreate:  Math.round(mean(ok.map(r => r.cacheCreate))),
    cacheRead:    Math.round(mean(ok.map(r => r.cacheRead))),
    outputTokens: Math.round(mean(ok.map(r => r.outputTokens))),
    durationMs:   Math.round(mean(ok.map(r => r.durationMs))),
    wallMs:       Math.round(mean(ok.map(r => r.wallMs))),
    costUSD:      mean(ok.map(r => r.costUSD)),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

const serverNames = Object.keys(servers);

console.log(`\nMCP Broker — Claude CLI Benchmark`);
console.log(`Config:  ${configPath}`);
console.log(`Servers: ${serverNames.join(", ")}`);
console.log(`Rounds:  ${roundsArg}`);
console.log(`Prompt:  "${PROMPT}"\n`);

// Strategy 1 — Direct: all real servers loaded upfront
console.log(`Strategy 1: Direct (all ${serverNames.length} servers)\n`);
const directConfig = buildMcpConfig(serverNames);
const directResult = await measureStrategy("direct", directConfig, roundsArg);
process.stdout.write(`  ✓ ${directResult.totalInput.toLocaleString()} total input tokens, ${directResult.durationMs.toLocaleString()}ms\n\n`);

// Strategy 2 — Broker idle: only 4 meta-tools
console.log(`Strategy 2: Broker idle (meta-tools only)\n`);
const brokerIdleConfig = buildMcpConfig([], [{ name: "broker", tools: BROKER_META_TOOLS }]);
const brokerIdleResult = await measureStrategy("broker-idle", brokerIdleConfig, roundsArg);
process.stdout.write(`  ✓ ${brokerIdleResult.totalInput.toLocaleString()} total input tokens, ${brokerIdleResult.durationMs.toLocaleString()}ms\n\n`);

// Strategy 3 — Broker worst case: meta-tools + all real servers
console.log(`Strategy 3: Broker worst-case (meta-tools + all ${serverNames.length} servers)\n`);
const brokerWorstConfig = buildMcpConfig(serverNames, [{ name: "broker", tools: BROKER_META_TOOLS }]);
const brokerWorstResult = await measureStrategy("broker-worst", brokerWorstConfig, roundsArg);
process.stdout.write(`  ✓ ${brokerWorstResult.totalInput.toLocaleString()} total input tokens, ${brokerWorstResult.durationMs.toLocaleString()}ms\n\n`);

// ─── Report ────────────────────────────────────────────────────────────────

const col  = (s, w) => String(s).padEnd(w);
const colR = (s, w) => String(s).padStart(w);
const pct  = (a, base) => base > 0 ? `${((1 - a / base) * 100).toFixed(1)}% saved` : "—";
const ms   = (v) => `${v.toLocaleString()}ms`;
const W    = 90;

console.log(`${"─".repeat(W)}`);
console.log(`RESULTS  (prompt: "${PROMPT}", ${roundsArg} round${roundsArg !== 1 ? "s" : ""} each)`);
console.log(`${"─".repeat(W)}`);
console.log(`${col("Strategy", 38)} ${colR("Total input tkns", 18)} ${colR("Savings vs direct", 20)} ${colR("Latency (mean)", 14)}`);
console.log(`${"─".repeat(W)}`);

const rows = [directResult, brokerIdleResult, brokerWorstResult];
for (const r of rows) {
  if (!r.ok) {
    console.log(`${col(r.label, 38)} ${colR("ERROR", 18)} ${colR("—", 20)} ${colR("—", 14)}`);
    continue;
  }
  const savings = r.label === "direct" ? "baseline" : pct(r.totalInput, directResult.totalInput);
  console.log(`${col(r.label, 38)} ${colR(r.totalInput.toLocaleString(), 18)} ${colR(savings, 20)} ${colR(ms(r.durationMs), 14)}`);
}

console.log(`${"─".repeat(W)}`);
console.log(`\nToken breakdown (cache_create + cache_read + uncached = total):`);
for (const r of rows.filter(r => r.ok)) {
  console.log(`  ${col(r.label, 30)} ${r.cacheCreate.toLocaleString()} create + ${r.cacheRead.toLocaleString()} read + ${r.inputTokens.toLocaleString()} uncached = ${r.totalInput.toLocaleString()}`);
}

console.log(`\nCost per request (mean):`);
for (const r of rows.filter(r => r.ok)) {
  console.log(`  ${col(r.label, 30)} $${r.costUSD.toFixed(6)}`);
}
console.log(`\n`);
