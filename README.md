# context-broker

> Lazy-loading MCP proxy for Claude Code. Instead of flooding the context window
> with every tool schema on every request, the broker exposes **6 meta-tools** (4 for
> servers, 2 for skills) and spawns real servers only when Claude needs them.

```
Claude Code  ──────────────────────────────────────────────────────────
               discover_tools · activate_server · deactivate_server · list_active_servers
               discover_skill · load_skill
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

**~96% fewer input tokens** when idle (see [Token savings](#token-savings) for how this was measured and its caveats). Servers load only when the task calls for them.

---

## Install

### npx — no setup required

```bash
claude mcp add --scope user context-broker -- npx -y context-broker
```

or add it to `~/.claude.json` (user scope) / `.mcp.json` (per project) by hand:

```json
{
  "mcpServers": {
    "context-broker": {
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

> Use the name **`context-broker`** everywhere — it is the name `migrate` registers, so
> following both this section and `migrate` does not give you two broker instances.

Requires Node.js ≥ 18.17.

### From source

```bash
git clone https://github.com/micaelmalta/context-broker.git
cd context-broker
npm install && npm run build
```

```json
{
  "mcpServers": {
    "context-broker": {
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

`config/servers.json` and `config/skills.json` in the repo are **examples only** and are never
loaded implicitly (their paths do not exist on real machines). With no config the broker starts
with an empty registry and logs where to put one.

Entries are validated on load (and on every reload). An invalid entry is skipped and reported
by name on stderr (e.g. ``servers.github — keywords: Expected array``) instead of breaking
discovery for everyone. `servers.json` is re-read on `discover_tools` and `activate_server`, and
`skills.json` on `discover_skill` / `load_skill`, so edits apply without restarting; a
half-written file keeps the previous config.
```json
{
  "servers": {
    "my-stdio-server": {
      "description": "One sentence — used by discover_tools to match queries",
      "keywords":    ["keyword1", "keyword2"],
      "command":     "npx",
      "args":        ["-y", "my-mcp-server"],
      "env":         { "API_KEY": "${MY_API_KEY}" },
      "inheritEnv":  false,
      "toolTimeoutMs": 300000,
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
    "docs": {
      "description": "Docs MCP — OAuth client and callback port auto-discovered (DCR)",
      "keywords":    ["docs", "api"],
      "type":        "http",
      "url":         "https://mcp.example.com/mcp",
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

`${VAR}` references are resolved from the shell environment where Claude Code runs. A reference to
an unset variable is logged as a warning (and resolves to an empty string).

`toolTimeoutMs` (optional) is the per-call timeout for `tools/call`, for both stdio and HTTP
servers. Default: 5 minutes.

> **Security note — environment inheritance.** By default child servers are spawned with the broker's
> *full* environment plus their own `env`. To limit that, set `inheritEnv` on a server: `false` passes
> only a minimal base set (`PATH`, `HOME`, locale, temp dirs, proxy and CA settings, `XDG_*`, …), and a
> list such as `["GITHUB_TOKEN", "AWS_*"]` adds the named variables (a trailing `*` is a prefix match).
> The server's own `env` entries are always added. Anything you export globally (including the secrets
> `migrate` writes to your shell file) is visible to every server. Prefer scoping secrets with
> `env` entries that reference variables you only set for the broker, or keep them in a
> dedicated env file loaded by your shell for Claude Code only.

**Tool names.** A server may not expose a tool whose name is already provided by another active
server, or that shadows one of the broker's own meta-tools — activation fails with a message
naming the clash. Deactivate the other server first.

**Errors** from the broker and from proxied calls are returned with `isError: true`, so the model
can tell a failure from a result.
### HTTP MCP OAuth

For `type: "http"` servers, auth is auto-discovered:

1. The broker connects without credentials. A `401` starts OAuth (set `oauth: true` or an object to authenticate up front; `oauth: false` to never use OAuth). A static `Authorization` header you configure is never replaced.
2. It discovers the authorization server (`/.well-known/oauth-protected-resource` → AS metadata).
3. If `oauth.clientId` is omitted and the AS exposes `registration_endpoint`, it registers a public client (DCR). The client and its callback port are remembered for next time.
4. If `oauth.callbackPort` is omitted, an ephemeral loopback port is used for the PKCE redirect.
5. The authorize and token requests carry the RFC 8707 `resource` parameter; scopes come from `oauth.scopes` or the server's protected-resource metadata (never "everything the AS supports").
6. The callback accepts only `GET /callback` with the matching `state`; the browser is launched without a shell (`open` / `xdg-open` / `rundll32`) and the URL is always printed to stderr as a fallback.
7. Tokens are stored under `~/.config/context-broker/tokens/` and DCR clients under `clients/` (directories `0700`, files `0600`), bound to the server URL they were issued for. On a `401` mid-session a **fresh** token is obtained (refresh token first) and the call is retried once.

Set `oauth: { clientId, callbackPort }` when the AS has no DCR (e.g. Slack). Requests always send `Accept: application/json, text/event-stream`, parse JSON or SSE bodies (matching the response by JSON-RPC `id`), send `MCP-Protocol-Version` after `initialize`, re-initialize once if the session expires (404), and close the session on deactivate.

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

Skills are discovered via `discover_skill` and loaded on demand via `load_skill`, exposing two additional meta-tools alongside the four server meta-tools. `migrate` and the `SessionStart` hook keep this file in sync automatically (same-named skills from different sources are registered as `name` and `name@source`).

### autoActivate

| Value | Behaviour |
|---|---|
| `false` *(default)* | Lazy — spawned only on `activate_server` or auto-activation. |
| `true` | Eager — spawned when the broker starts; tools immediately visible. |

Use `true` for servers you reach every session (e.g. a filesystem or fetch server).
Use `false` for heavy servers that run `docker build` or `npm install` on first launch.

Auto-activation runs in the background *after* the broker has connected, so a slow server never delays startup.

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

When Claude calls a tool it hasn't activated yet, the broker attempts **auto-activation** — it scores all servers against the tool name and activates the best match (failures are reported as tool errors).

The broker sends `notifications/tools/list_changed` whenever the exposed tool set changes: on activate, on deactivate, when a server exits unexpectedly, and when a server itself announces a change.

**Learned tool descriptions.** Migrated servers only have a generic description, so each time a server is activated the broker records its tool names and descriptions in `~/.config/context-broker/tool-index.json` (keyed by the server's command/URL, so edits invalidate it). Later `discover_tools` calls also match against that text — worth up to +2 per query, shown as `tools:` in the match line — so a server can be found by what its tools do before it has been activated again in a session.

**Matching** is word-based: the query is tokenised and compared with keywords (+2 each, multi-word keywords match as phrases) and description words longer than 4 characters (+1 each), with light plural handling. `git` therefore does not match "digital" and `pr` does not match "prompt".

---

## Token savings

Measured with `claude -p` across **9 real MCP servers**, 2 rounds each (with an earlier build that
exposed 4 meta-tools; the broker now exposes 6, so idle cost is slightly higher — re-run the
benchmark for current numbers):

```
  Without broker   29,793 tokens of MCP schema injected per request
  With broker         773 tokens              (96.5% less, −29,020 tokens/req)
  Cost saving      $0.109 per request   ≈ $109.81 per 1,000 requests
```

| Strategy | Tokens | Cost / request | vs direct |
|---|---|---|---|
| baseline — no MCP at all | 283 | $0.00091 | — |
| direct — all 9 servers upfront | 30,076 | $0.11324 | — |
| **broker idle** — meta-tools only | **1,056** | **$0.00342** | **−29,020** |
| activated — broker + all 9 servers | 30,352 | $0.11427 | +276 |

**Caveats.** Each run is a single *cold-cache* turn, so these are first-turn costs. In a long
session tool schemas are prompt-cached and cost far less per turn — the dollar figures above
overstate steady-state savings, while the token-count reduction (context-window space) is real.
The worst case — every server active simultaneously — costs roughly the same as loading
everything directly. Normal sessions activate 1–2 servers per task, so the real cost stays close
to idle. HTTP servers are benchmarked only if they have a static `Authorization` header
(interactive OAuth can't run under `claude -p`); skipped servers are listed in the output.

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

- **Servers** — converts entries (stdio **and** HTTP) to broker format with `description`, `keywords`, `autoActivate: false` and a `migratedFrom` marker (`claude`, `cursor`, `opencode`, or `plugin` for servers shipped by Claude Code plugins). Re-running keeps your edits to `description`, `keywords` and `autoActivate`. Cursor's `${env:VAR}` syntax is normalised to `${VAR}`. Only *global* Claude servers are migrated; project-scoped ones (`projects[path].mcpServers` in `~/.claude.json`) are left alone.
- **Broker registration** — `context-broker` is added to `~/.claude.json`, and to Cursor's / OpenCode's config when you migrate from them (Cursor: `mcpServers`; OpenCode: `mcp` with a command array). Revert removes it from those files again.
- **Skills** — registers them **in place** in `skills.json` (nothing is moved or symlinked); each `SKILL.md` is split into a stub (frontmatter + a one-line pointer) and `INSTRUCTIONS.md` next to it. Same-named skills from different sources are registered as `name` and `name@source`.
- **Plugins** — registers all plugin skills from `~/.claude/plugins/cache/` in `skills.json`; installs `session-sync.mjs` and adds a `SessionStart` hook that keeps registrations fresh after plugin updates (it preserves the `migratedFrom` / `plugin` markers, so `revert` keeps working). Plugins whose MCP server was migrated are disabled to avoid loading twice; the exact set is recorded for `revert`.
- **Secrets** — values matching `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD` (and secret-looking `Authorization`/API-key **headers**) are extracted to the appropriate shell config and replaced with `${VAR}` references; already-present vars are not duplicated. The destination is shell-aware: `~/.config/fish/config.fish` for fish, `~/.bashrc` for bash, `~/.zshenv` for zsh and others. Values are escaped to prevent shell interpolation.
- **Safety** — every config file it modifies (`~/.claude.json`, `~/.cursor/mcp.json`, `~/.claude/settings.json`, your shell file, …) is first copied to `<file>.bak-<timestamp>` and then written atomically. `servers.json` is written before anything is removed from a source config.

### Undo a migration

```bash
# Restore everything — servers back to their original client configs, plugins re-enabled,
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

- **Servers** — finds entries by their `migratedFrom` marker (or the legacy `Migrated from <source>` description) and writes them back to that client's config **in its own format** (`mcpServers` for Claude/Cursor, `mcp` with a command array for OpenCode; `${env:VAR}` for Cursor). `--from plugin` just removes plugin-provided entries and re-enables the plugins. Plugins that `migrate` disabled are re-enabled; others are left alone.
- **Broker registration** — `context-broker` is removed from `~/.claude.json` only once no migrated servers remain, so a partial revert never strands the others.
- **Skills** — merges `INSTRUCTIONS.md` back into `SKILL.md` and removes the registry entries (nothing was moved, so nothing needs moving back).
- **Plugins** — merges `INSTRUCTIONS.md` back into each plugin's `SKILL.md`, removes plugin entries from `skills.json`, and removes the `SessionStart` session-sync hook from `~/.claude/settings.json`.
- Secrets that `migrate` appended to your shell file are **left in place**; remove them by hand if you no longer need them.

---

## Verify

Start Claude Code and ask:

```
list active servers
```

Expected response: `No servers currently active.` — the broker is running, no child processes have been spawned yet.
