# lazygate reference

Details that don't fit in the [README](../README.md): configuration fields, OAuth, routing, migration
and benchmarking.

- [Configuration](#configuration)
- [HTTP servers and OAuth](#http-servers-and-oauth)
- [Skills](#skills)
- [Routing](#routing)
- [Migration](#migration)
- [Benchmark](#benchmark)
- [Upgrading from context-broker](#upgrading-from-context-broker)

---

## Configuration

Files live in `~/.config/lazygate/`:

| File | Purpose |
|---|---|
| `servers.json` | server registry |
| `skills.json` | skill registry |
| `tool-index.json` | learned tool names/descriptions (written by lazygate, safe to delete) |
| `tokens/`, `clients/` | OAuth tokens and registered clients (`0700` dirs, `0600` files) |
| `scripts/` | `session-sync.mjs` and `lib/`, installed by `migrate` |

**Resolution order:** `--config <path>` / `--skills <path>` flag, then `~/.config/lazygate/<file>`. With
neither, lazygate starts with an empty registry and logs where to put one. `config/*.json` in the repo
are examples only and are never loaded implicitly.

Entries are validated on load and on every reload. An invalid entry is skipped and reported once on
stderr by name (``servers.github — keywords: Expected array``) instead of breaking discovery for
everyone. `servers.json` is re-read on `discover_tools` / `activate_server` and `skills.json` on
`discover_skill` / `load_skill`, so edits apply without a restart; a half-written file keeps the
previous config.

### servers.json

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
      "headers":     { "Authorization": "Bearer ${MY_TOKEN}" }
    },
    "slack": {
      "description": "Slack — search messages, send communications, manage canvases",
      "keywords":    ["slack", "message", "channel", "canvas"],
      "type":        "http",
      "url":         "https://mcp.slack.com/mcp",
      "oauth":       { "clientId": "xxx", "callbackPort": 3118 }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `description`, `keywords` | what `discover_tools` matches against |
| `command`, `args`, `env` | stdio server. `${VAR}` is resolved from the environment lazygate runs in; an unset variable logs a warning and becomes an empty string |
| `type`, `url`, `headers`, `oauth` | HTTP server (see below) |
| `inheritEnv` | environment passed to a stdio child — see below |
| `toolTimeoutMs` | per-call `tools/call` timeout for stdio and HTTP. Default 5 minutes |
| `autoActivate` | `false` (default): spawned on `activate_server` or auto-activation. `true`: spawned when lazygate starts, in the background after it has connected, so a slow server never delays startup. Use `true` for servers you reach every session; keep heavy ones (`docker build`, `npm install` on first launch) `false` |
| `auth`, `groups` | gateway mode only — credential sources and access policy; see [gateway.md](gateway.md) |
| `migratedFrom`, `disabledPlugins` | set by `migrate`; `revert` relies on them |

**Environment inheritance.** By default a stdio child gets lazygate's full environment plus its own
`env`. Everything you export globally — including the secrets `migrate` writes to your shell file — is
visible to every server. Set `inheritEnv` to limit that:

- `false` — only a minimal base set (`PATH`, `HOME`, locale, temp dirs, proxy and CA settings, `XDG_*`, …)
- `["GITHUB_TOKEN", "AWS_*"]` — the base set plus the named variables (trailing `*` is a prefix match)

The server's own `env` entries are always added on top.

**Tool names.** A server may not expose a tool whose name is already provided by another active server,
or that shadows one of lazygate's meta-tools. Activation fails with a message naming the clash;
deactivate the other server first.

**Errors** from lazygate and from proxied calls are returned with `isError: true`.

---

## HTTP servers and OAuth

For `type: "http"` servers, auth is auto-discovered:

1. lazygate connects without credentials. A `401` starts OAuth (`oauth: true` or an object authenticates
   up front; `oauth: false` never uses OAuth). A static `Authorization` header is never replaced.
2. It discovers the authorization server (`/.well-known/oauth-protected-resource`, then AS metadata).
3. If `oauth.clientId` is omitted and the AS has a `registration_endpoint`, it registers a public
   client (dynamic client registration). The client and its callback port are remembered.
4. If `oauth.callbackPort` is omitted, an ephemeral loopback port is used for the PKCE redirect.
5. Authorize and token requests carry the RFC 8707 `resource` parameter. Scopes come from
   `oauth.scopes` or the server's protected-resource metadata, never "everything the AS supports".
6. The callback accepts only `GET /callback` with the matching `state`. The browser is launched without
   a shell (`open` / `xdg-open` / `rundll32`) and the URL is always printed to stderr as a fallback.
7. Tokens are stored under `~/.config/lazygate/tokens/`, bound to the server URL they were issued for.
   On a `401` mid-session a fresh token is obtained (refresh token first) and the call is retried once.

Set `oauth: { clientId, callbackPort }` when the AS has no dynamic registration (e.g. Slack).

Requests send `Accept: application/json, text/event-stream`, parse JSON or SSE bodies (matched by
JSON-RPC `id`), send `MCP-Protocol-Version` after `initialize`, re-initialize once if the session
expires (404), and close the session on deactivate.

---

## Skills

`skills.json` registers file-based skills that are loaded on demand:

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

`migrate` and the `SessionStart` hook keep this file in sync. Same-named skills from different sources
are registered as `name` and `name@source`.

Each migrated `SKILL.md` is split into:

- `SKILL.md` — frontmatter plus a one-line `<!-- lazygate: … -->` pointer (what the client injects every session)
- `INSTRUCTIONS.md` — the body, returned by `load_skill`

`revert` merges them back, reproducing the original file.

---

## Routing

`discover_tools` / `discover_skill` score each entry against the query:

- keywords: +2 each (multi-word keywords match as phrases)
- description words longer than 4 characters: +1 each
- learned tool words (servers only): up to +2 in total
- light plural handling, so `git` does not match "digital" and `pr` does not match "prompt"

**Learned tool descriptions.** Migrated servers only have a generic description. Each time a server is
activated, lazygate records its tool names and descriptions in `tool-index.json` (keyed by the server's
command/URL, so edits invalidate it). Later `discover_tools` calls also match against that text, shown
as `tools:` in the match line.

**Auto-activation.** If the client calls a tool that isn't active, lazygate scores all servers against the
tool name, activates the best match and retries once. Failures come back as tool errors.

lazygate sends `notifications/tools/list_changed` whenever the exposed tool set changes: on activate,
on deactivate, when a server exits unexpectedly, and when a server announces a change itself.

---

## Migration

```bash
npx lazygate migrate --from claude        # ~/.claude.json, ~/.claude/skills, plugin cache
npx lazygate migrate --from cursor        # ~/.cursor/mcp.json
npx lazygate migrate --from opencode      # ~/.config/opencode/opencode.json
npx lazygate migrate --from /path/to.json # any file with an mcpServers map

npx lazygate migrate --from claude --dry-run
npx lazygate migrate --from claude --servers   # or --skills / --plugins
```

**What it does**

- **Servers** — converts stdio and HTTP entries to lazygate format with `description`, `keywords`,
  `autoActivate: false` and a `migratedFrom` marker (`claude`, `cursor`, `opencode`, or `plugin` for
  servers shipped by Claude Code plugins). Re-running keeps your edits to `description`, `keywords` and
  `autoActivate`. Cursor's `${env:VAR}` syntax is normalised to `${VAR}`. Only *global* Claude servers
  are migrated; project-scoped ones (`projects[path].mcpServers`) are left alone.
- **Registration** — adds `lazygate` to `~/.claude.json`, and to Cursor's (`mcpServers`) or OpenCode's
  (`mcp`, command array) config when you migrate from them.
- **Skills** — registers them in place in `skills.json` (nothing is moved) and splits each `SKILL.md`.
- **Plugins** — registers plugin skills from `~/.claude/plugins/cache/`, installs `session-sync.mjs` and a
  `SessionStart` hook that keeps registrations fresh after plugin updates, and disables plugins whose
  MCP server was migrated (recorded for `revert`).
- **Secrets** — values matching `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD` (and secret-looking
  `Authorization` / API-key headers) are moved to your shell config and replaced with `${VAR}`
  references: `~/.config/fish/config.fish` for fish, `~/.bashrc` for bash, `~/.zshenv` otherwise.
  Existing variables are not duplicated and values are escaped.
- **Safety** — every config file it modifies is first copied to `<file>.bak-<timestamp>` and written
  atomically. `servers.json` is written before anything is removed from a source config.

### Undo

```bash
npx lazygate revert --from claude             # everything
npx lazygate revert --from claude --dry-run
npx lazygate revert --from cursor --servers   # or --skills / --plugins
```

- **Servers** — finds entries by `migratedFrom` and writes them back in that client's own format
  (`mcpServers` for Claude/Cursor, `mcp` with a command array for OpenCode, `${env:VAR}` for Cursor).
  `--from plugin` removes plugin-provided entries and re-enables the plugins `migrate` disabled.
- **Registration** — removes `lazygate` from Cursor/OpenCode when their servers are restored, and from
  `~/.claude.json` only once no migrated servers remain, so a partial revert never strands the rest.
- **Skills and plugins** — merges `INSTRUCTIONS.md` back into `SKILL.md`, removes registry entries and
  the `SessionStart` hook.
- Secrets that `migrate` appended to your shell file are left in place; remove them by hand if unwanted.

---

## Benchmark

```bash
npx lazygate benchmark
npx lazygate benchmark --servers fetch-mcp,jira   # subset
npx lazygate benchmark --rounds 3                 # average over rounds
```

Measured with `claude -p` across 9 real MCP servers, 2 rounds each (with an earlier build exposing 4
meta-tools; there are now 6, so idle cost is slightly higher — re-run for current numbers):

| Strategy | Tokens | Cost / request |
|---|---|---|
| baseline — no MCP at all | 283 | $0.00091 |
| direct — all 9 servers upfront | 30,076 | $0.11324 |
| **lazygate idle** — meta-tools only | **1,056** | **$0.00342** |
| activated — lazygate + all 9 servers | 30,352 | $0.11427 |

Idle lazygate injects about 29,000 fewer tokens per request (−96%).

**Caveats.** Each run is a single cold-cache turn, so these are first-turn costs. In a long session tool
schemas are prompt-cached and cost far less per turn, so the dollar figures overstate steady-state
savings; the token reduction (context-window space) is real. The worst case — every server active at
once — costs about the same as loading everything directly; normal sessions activate one or two servers.
HTTP servers are benchmarked only if they have a static `Authorization` header (OAuth can't run under
`claude -p`); skipped servers are listed in the output.

---

## Upgrading from context-broker

The project was renamed from `context-broker` to `lazygate`. Existing installs upgrade in place:

- `~/.config/context-broker` is moved to `~/.config/lazygate` the first time lazygate, `migrate`,
  `revert` or `session-sync` runs. The old path is left as a symlink so an old hook keeps working.
  (`--dry-run` moves nothing.)
- Re-run `npx lazygate migrate` to replace a `context-broker` entry in your client configs and the old
  `SessionStart` hook with `lazygate` ones. `revert` removes either name.
- Skills split before the rename keep their old `<!-- context-broker: -->` pointer; it is still
  recognised when merging back.
- If you registered the broker by hand, change the command to `lazygate` (or `npx -y lazygate`).
