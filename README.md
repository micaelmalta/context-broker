# context-broker

> Lazy-loading MCP proxy for Claude Code. Instead of flooding the context window
> with every tool schema on every request, the broker exposes **4 meta-tools** and
> spawns real servers only when Claude needs them.

```
Claude Code  ──────────────────────────────────────────────────────────
               discover_tools · activate_server · deactivate_server · list_active_servers
                                        │
                              ┌──────────▼──────────┐
                              │    context-broker    │
                              └──────────┬──────────┘
                    ┌──────────┬────────┴────────┬──────────┐
                 spawned    spawned           spawned    spawned
                on demand  on demand         on demand  on demand
                   │          │                 │          │
                 jira      github           postgres   fetch-mcp
```

**96.5% fewer input tokens** when idle. Servers load only when the task calls for them.

---

## Install

### npx — no setup required

Add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-project):

```json
{
  "mcpServers": {
    "broker": {
      "command": "npx",
      "args": ["-y", "context-broker"]
    }
  }
}
```

Pin a version:

```json
"args": ["-y", "context-broker@1.0.0"]
```

### From source

```bash
git clone https://github.com/micaelmalta/context-broker.git
cd context-broker
npm install && npm run build
```

```json
{
  "mcpServers": {
    "broker": {
      "command": "node",
      "args": ["/absolute/path/to/context-broker/dist/index.js"]
    }
  }
}
```

---

## Configure

### servers.json

Create `~/.config/context-broker/servers.json`:

```bash
# Via npx — pull the example config
mkdir -p ~/.config/context-broker
curl -fsSL https://raw.githubusercontent.com/micaelmalta/context-broker/main/config/servers.json \
  > ~/.config/context-broker/servers.json

# From a local clone
cp config/servers.json ~/.config/context-broker/servers.json
```

**Config resolution order:**
1. `--config <path>` flag passed to the broker
2. `~/.config/context-broker/servers.json`
3. `./config/servers.json` (local clone fallback)

```json
{
  "servers": {
    "my-stdio-server": {
      "description": "One sentence — used by discover_tools to match queries",
      "keywords":    ["keyword1", "keyword2"],
      "command":     "npx",
      "args":        ["-y", "my-mcp-server"],
      "env":         { "API_KEY": "${MY_API_KEY}" },
      "autoActivate": false
    },
    "my-http-server": {
      "description": "Remote MCP server over HTTP with static auth",
      "keywords":    ["keyword1", "keyword2"],
      "type":        "http",
      "url":         "https://my-mcp-server.example.com/mcp",
      "headers":     { "Authorization": "Bearer ${MY_TOKEN}" },
      "autoActivate": false
    },
    "slack": {
      "description": "Slack — search messages, send communications, manage canvases",
      "keywords":    ["slack", "message", "channel", "canvas"],
      "type":        "http",
      "url":         "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId":    "xxx",
        "callbackPort": 3118
      },
      "autoActivate": false
    }
  }
}
```

`${VAR}` references are resolved from the shell environment where Claude Code runs.

### skills.json

The broker also lazily loads **skills** — file-based instruction sets for Claude. Create `~/.config/context-broker/skills.json`:

```json
{
  "skills": {
    "my-skill": {
      "description": "One sentence — used by discover_skill to match queries",
      "keywords":    ["keyword1", "keyword2"],
      "path":        "/path/to/skills/my-skill/SKILL.md"
    }
  }
}
```

Skills are discovered via `discover_skill` and loaded on demand via `load_skill`, exposing two additional meta-tools alongside the four server meta-tools.

### autoActivate

| Value | Behaviour |
|---|---|
| `false` *(default)* | Lazy — spawned only on `activate_server` or auto-activation. |
| `true` | Eager — spawned when the broker starts; tools immediately visible. |

Use `true` for servers you reach every session (e.g. a filesystem or fetch server).
Use `false` for heavy servers that run `docker build` or `npm install` on first launch.

---

## How it works

Claude interacts through 6 meta-tools — 4 for servers, 2 for skills:

| Tool | What it does |
|---|---|
| `discover_tools` | Scores all configured servers against a query; returns ranked matches |
| `activate_server` | Spawns a server process, runs the MCP handshake, exposes its tools |
| `deactivate_server` | Kills the server process and frees resources |
| `list_active_servers` | Lists running servers and their loaded tools |
| `discover_skill` | Scores all configured skills against a query; returns ranked matches |
| `load_skill` | Reads and returns the full skill instructions on demand |

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

When Claude calls a tool it hasn't activated yet, the broker attempts **auto-activation** — it scores all servers against the tool name and activates the best match.

---

## Token savings

Measured with `claude -p` across **9 real MCP servers**, 2 rounds each:

```
  Without broker   29,793 tokens of MCP schema injected per request
  With broker         773 tokens              (96.5% less, −29,020 tokens/req)
  Cost saving      $0.109 per request   ≈ $109.81 per 1,000 requests
```

| Strategy | Tokens | Cost / request | vs direct |
|---|---|---|---|
| baseline — no MCP at all | 283 | $0.00091 | — |
| direct — all 9 servers upfront | 30,076 | $0.11324 | — |
| **broker idle** — 4 meta-tools only | **1,056** | **$0.00342** | **−29,020** |
| activated — broker + all 9 servers | 30,352 | $0.11427 | +276 |

The worst case — every server active simultaneously — costs roughly the same as loading everything directly. Normal sessions activate 1–2 servers per task, so the real cost stays close to idle.

Run the benchmark against your own config:

```bash
npx context-broker benchmark

# Subset of servers
npx context-broker benchmark --servers fetch-mcp,jira

# Average over multiple rounds
npx context-broker benchmark --rounds 3
```

---

## Migration

Import your existing MCP servers, skills, and plugin skills in one command:

```bash
# From Claude Code  (~/.claude.json + ~/.claude/skills/ + ~/.claude/plugins/cache/)
npx context-broker migrate --from claude

# From Cursor  (~/.cursor/mcp.json)
npx context-broker migrate --from cursor

# From OpenCode  (~/.config/opencode/opencode.json)
npx context-broker migrate --from opencode

# From any file
npx context-broker migrate --from /path/to/mcp.json

# Preview changes without writing
npx context-broker migrate --from claude --dry-run

# Migrate only specific parts
npx context-broker migrate --from claude --servers
npx context-broker migrate --from claude --skills
npx context-broker migrate --from claude --plugins
```

**What the migration does:**

- **Servers** — converts `{ command, args, env }` entries to broker format with `description`, `keywords`, and `autoActivate: false`; skips self-referential entries and HTTP/SSE servers
- **Skills** — moves `~/.claude/skills/` into `~/.config/context-broker/skills/`, registers them in `skills.json`, and leaves a symlink so slash commands (`/loi`, `/loi-generate`, etc.) keep working
- **Plugins** — registers all plugin skills from `~/.claude/plugins/cache/` in `skills.json`; adds a `SessionStart` hook to keep registrations fresh after plugin updates
- **Secrets** — values matching `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD` are extracted to `~/.zshenv` and replaced with `${VAR}` references; already-present vars are not duplicated

### Undo a migration

```bash
# Restore everything — servers back to ~/.claude.json, skills back to ~/.claude/skills/,
# plugin SKILL.md files restored, SessionStart hook removed
npx context-broker revert --from claude

# Preview without writing
npx context-broker revert --from claude --dry-run

# Revert only specific parts
npx context-broker revert --from claude --servers
npx context-broker revert --from claude --skills
npx context-broker revert --from claude --plugins
```

**What the revert does:**

- **Servers** — writes all entries from `servers.json` back to the source config's `mcpServers`
- **Skills** — merges `INSTRUCTIONS.md` back into `SKILL.md`, removes the symlink, and moves the skill directory back to `~/.claude/skills/`
- **Plugins** — merges `INSTRUCTIONS.md` back into each plugin's `SKILL.md`, removes plugin entries from `skills.json`, and removes the `SessionStart` split-skills hook from `~/.claude/settings.json`

---

## Verify

Start Claude Code and ask:

```
list active servers
```

Expected response: `No servers currently active.` — the broker is running, no child processes have been spawned yet.
