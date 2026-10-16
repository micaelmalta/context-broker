# lazygate

> A lazy-loading MCP gateway for Claude Code (and Cursor, OpenCode). Instead of putting every tool
> schema in the context window on every request, lazygate exposes **6 meta-tools** and starts real
> MCP servers and skills only when the task needs them.

```
Claude Code ── discover_tools · activate_server · deactivate_server · list_active_servers
               discover_skill · load_skill
                         │
                 ┌───────▼───────┐
                 │   lazygate    │
                 └───────┬───────┘
          spawned on demand, only when needed
            │        │         │         │
          jira    github   postgres   fetch-mcp
```

**~96% fewer input tokens when idle** (30,000 → ~1,000 across 9 servers; see
[benchmark](docs/reference.md#benchmark) for the method and caveats).

> Formerly `context-broker`. Existing installs upgrade in place — see
> [Upgrading](docs/reference.md#upgrading-from-context-broker).

---

## Quick start

```bash
# 1. Import your existing MCP servers and skills (backs up every file it touches)
npx -y lazygate migrate --from claude        # or: cursor, opencode

# 2. Restart your client and ask:  "list active servers"
#    → "No servers currently active."   (lazygate is running; nothing spawned yet)
```

`migrate` registers lazygate in your client for you, so there is nothing else to configure. Add
`--dry-run` to preview. To undo: `npx -y lazygate revert --from claude`.

Requires Node.js ≥ 18.17.

### Manual install

```bash
claude mcp add --scope user lazygate -- npx -y lazygate
```

or in `~/.claude.json` / `.mcp.json`:

```json
{ "mcpServers": { "lazygate": { "command": "npx", "args": ["-y", "lazygate"] } } }
```

From source:

```bash
git clone https://github.com/micaelmalta/lazygate.git && cd lazygate
npm install && npm run build
# then use: { "command": "node", "args": ["/absolute/path/to/lazygate/dist/index.js"] }
```

Use the name `lazygate` everywhere, so manual setup and `migrate` don't give you two instances.

---

## Configure

Servers live in `~/.config/lazygate/servers.json` (created by `migrate`, or write it by hand):

```json
{
  "servers": {
    "github": {
      "description": "GitHub — search issues and pull requests, read repositories",
      "keywords": ["github", "issue", "pull request"],
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "autoActivate": false
    },
    "docs": {
      "description": "Remote docs server",
      "keywords": ["docs", "api"],
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

- `description` and `keywords` are what `discover_tools` matches against.
- `autoActivate: true` starts a server when lazygate starts; the default is on demand.
- HTTP servers support static headers and OAuth (auto-discovered, with dynamic client registration).
- Edits apply without a restart.

Every field, OAuth, `inheritEnv` (limit which environment variables a server sees) and skills are in
the [reference](docs/reference.md#configuration).

---

## How it works

| Tool | What it does |
|---|---|
| `discover_tools` | Ranks configured servers against a query |
| `activate_server` | Starts a server, does the MCP handshake, exposes its tools |
| `deactivate_server` | Stops a server and frees it |
| `list_active_servers` | Lists running servers and their tools |
| `discover_skill` | Ranks configured skills against a query |
| `load_skill` | Returns a skill's full instructions on demand |

```
You:    "Search GitHub for issues labelled 'bug'"
Claude: discover_tools("search github issues")  → github, fetch-mcp
Claude: activate_server("github")               → 12 tools now available
Claude: search_issues(label: "bug")
```

If Claude calls a tool that isn't active yet, lazygate activates the best-matching server and retries.
Whenever the tool set changes it sends `notifications/tools/list_changed`. Failures are returned with
`isError: true`. More in [Routing](docs/reference.md#routing).

---

## Migrate and revert

```bash
npx -y lazygate migrate --from claude [--dry-run] [--servers | --skills | --plugins]
npx -y lazygate revert  --from claude [--dry-run] [--servers | --skills | --plugins]
```

`--from` accepts `claude`, `cursor`, `opencode`, or a path to an `mcpServers` file. `migrate`:

- converts servers (stdio and HTTP) and moves secrets out of the configs into your shell file;
- registers skills and commands in place and splits each `SKILL.md` into a short stub plus an
  `INSTRUCTIONS.md` that is loaded on demand;
- registers lazygate in the source client and adds a `SessionStart` hook that keeps skills in sync;
- backs up every file it modifies (`<file>.bak-<timestamp>`) and writes atomically.

`revert` restores servers in each client's own format, merges `SKILL.md` files back and removes the hook.
Details and limits (for example, project-scoped Claude servers are not migrated) are in the
[reference](docs/reference.md#migration).

---

## HTTP gateway (POC)

`lazygate serve` shares one instance over Streamable HTTP, with a token per user, per-user credentials
sent as headers (`X-Lazygate-Cred-<server>-<field>`), shared server secrets, and per-user OAuth tokens:

```bash
npx -y lazygate token create --user alice --groups eng   # shown once
npx -y lazygate serve                                    # http://127.0.0.1:8787/mcp
```

A web UI at `/ui` manages your own keys, and (with an admin token) tokens, secrets and servers.
See [docs/gateway.md](docs/gateway.md).

---

## Development

```bash
npm run build       # tsc → dist/
npm run typecheck
npm test            # builds first, then jest
npm run dev         # run from source
npm run benchmark   # measure token savings (needs `claude` on PATH)
```

See [CLAUDE.md](CLAUDE.md) for the architecture and [docs/reference.md](docs/reference.md) for the full
reference.
