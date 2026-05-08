# mcp-broker

> Lazy-loading MCP proxy for Claude Code. Instead of flooding the context window
> with every tool schema on every request, the broker exposes **4 meta-tools** and
> spawns real servers only when Claude needs them.

```
Claude Code  ──────────────────────────────────────────────────────────
               discover_tools · activate_server · deactivate_server · list_active_servers
                                        │
                              ┌─────────▼─────────┐
                              │     mcp-broker     │
                              └─────────┬─────────┘
                    ┌──────────┬────────┴────────┬──────────┐
                 spawned    spawned           spawned    spawned
                on demand  on demand         on demand  on demand
                   │          │                 │          │
                 jira      github           postgres   fetch-mcp
```

**96.6 % fewer input tokens** when idle. Servers load only when the task calls for them.

---

## Install

### npx — no setup required

Add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-project):

```json
{
  "mcpServers": {
    "broker": {
      "command": "npx",
      "args": ["-y", "mcp-broker"]
    }
  }
}
```

Pin a version:

```json
"args": ["-y", "mcp-broker@1.0.0"]
```

### From source

```bash
git clone https://github.com/micaelmalta/mcp-broker.git
cd mcp-broker
npm install && npm run build
```

```json
{
  "mcpServers": {
    "broker": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-broker/dist/index.js"]
    }
  }
}
```

---

## Configure

Create `~/.config/mcp-broker/servers.json`:

```bash
# Via npx — pull the example config
mkdir -p ~/.config/mcp-broker
curl -fsSL https://raw.githubusercontent.com/micaelmalta/mcp-broker/main/config/servers.json \
  > ~/.config/mcp-broker/servers.json

# From a local clone
cp config/servers.json ~/.config/mcp-broker/servers.json
```

**Config resolution order:**
1. `--config <path>` flag passed to the broker
2. `~/.config/mcp-broker/servers.json`
3. `./config/servers.json` (local clone fallback)

### servers.json schema

```json
{
  "servers": {
    "my-server": {
      "description": "One sentence — used by discover_tools to match queries",
      "keywords":    ["keyword1", "keyword2"],
      "command":     "npx",
      "args":        ["-y", "my-mcp-server"],
      "env": {
        "API_KEY": "${MY_API_KEY}"
      },
      "autoActivate": false
    }
  }
}
```

`${VAR}` references are resolved from the shell environment where Claude Code runs.

### autoActivate

| Value | Behaviour |
|---|---|
| `false` *(default)* | Lazy — spawned only on `activate_server` or auto-activation. |
| `true` | Eager — spawned when the broker starts; tools immediately visible. |

Use `true` for servers you reach every session (e.g. a filesystem or fetch server).
Use `false` for heavy servers that run `docker build` or `npm install` on first launch — lazy keeps the idle cost low.

---

## How it works

Claude interacts exclusively through the 4 meta-tools:

| Tool | What it does |
|---|---|
| `discover_tools` | Scores all configured servers against a query; returns ranked matches |
| `activate_server` | Spawns a server process, runs the MCP handshake, exposes its tools |
| `deactivate_server` | Kills the server process and frees resources |
| `list_active_servers` | Lists running servers and their loaded tools |

### Typical flow

```
User: "Search GitHub for issues labelled 'bug'"

Claude → discover_tools("search github issues")
       → github (score 4), fetch-mcp (score 1)

Claude → activate_server("github")
       → 12 tools now available

Claude → search_issues(label: "bug")
       → ...
```

When Claude calls a tool it hasn't activated yet, the broker attempts **auto-activation** — it scores all servers against the tool name and activates the best match. This is an escape hatch; the preferred path is explicit discover → activate.

---

## Token savings

Measured with `claude -p` across **9 real MCP servers**, 2 rounds each:

| Strategy | Input tokens | Saved | Cost / request |
|---|---|---|---|
| Direct — all schemas, every request | 30,044 | — | $0.1131 |
| Broker idle — 0 servers active | 1,024 | **96.6 %** | $0.0031 |
| Broker worst-case — all 9 active | 30,320 | ≈ 0 % | $0.1142 |

The worst case — every server active simultaneously — costs the same as loading everything directly. Normal sessions activate 1–2 servers per task, so the real cost stays close to idle.

Run the benchmark against your own config:

```bash
npm run benchmark

# Subset of servers
npm run benchmark -- --servers fetch-mcp,jira

# Average over multiple rounds
npm run benchmark -- --rounds 3
```

---

## Migration

Import your existing MCP servers in one command:

```bash
# From Cursor  (~/.cursor/mcp.json)
node scripts/migrate.mjs --from cursor

# From Claude Code  (~/.claude.json)
node scripts/migrate.mjs --from claude

# From OpenCode  (~/.config/opencode/opencode.json)
node scripts/migrate.mjs --from opencode

# From any file
node scripts/migrate.mjs --from /path/to/mcp.json

# Preview changes without writing
node scripts/migrate.mjs --from cursor --dry-run

# Write to a custom path
node scripts/migrate.mjs --from cursor --out /path/to/servers.json
```

Or via npm: `npm run migrate -- --from cursor`

**What the migration does:**
- Converts `{ command, args, env }` entries to broker format with `description`, `keywords`, and `autoActivate: false`
- Skips self-referential entries (broker/router) and HTTP/SSE servers (`url:`-based)
- Merges with any existing `servers.json` — manually added entries are never overwritten
- Infers keywords from the server name and command arguments

> **Secrets** — values matching `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, and similar patterns are extracted to `~/.zshenv` and replaced with `${VAR}` references. Already-present vars are not duplicated.

### Undo a migration

```bash
# Remove all entries imported from Cursor + their secrets from ~/.zshenv
node scripts/revert-migration.mjs --from cursor

# Preview without writing
node scripts/revert-migration.mjs --from cursor --dry-run

# Custom config path
node scripts/revert-migration.mjs --from cursor --config /path/to/servers.json
```

Or via npm: `npm run revert-migration -- --from cursor`

Only entries stamped `"Migrated from <source>"` are removed. Manually added entries are untouched.

---

## Verify

Start Claude Code and ask:

```
list active servers
```

Expected response: `No servers currently active.` — the broker is running, no child processes have been spawned yet.
