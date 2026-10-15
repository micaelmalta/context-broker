# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run dev         # run from source via tsx (no build step)
npm test            # builds first (pretest), then runs jest (ESM mode)
npm run benchmark   # measure token savings across strategies (needs a build)
npm run migrate     # node dist/index.js migrate (needs a build; pass args with --)
npm run revert-migration  # node dist/index.js revert
```

Tests live in `src/__tests__/`. The migration tests run the real `scripts/*.mjs` as child
processes against a temporary `HOME`, so they need `dist/` (the `pretest` build provides it).
Tests that touch OAuth mock `os.homedir()` — never let a test write to the real
`~/.config/context-broker`.

## Architecture

context-broker is an MCP server that itself acts as a proxy. It exposes **6 meta-tools** to Claude Code instead of loading all real MCP server schemas upfront. Real servers and skills are loaded on demand.

### Source files (`src/`)

| File | Role |
|---|---|
| `index.ts` | Entry point. Subcommand dispatch (`migrate`/`revert`/`benchmark`), config loading, wires the MCP SDK server, connects stdio, *then* auto-activates `autoActivate` servers in the background |
| `broker.ts` | `createBroker({router, manager, skillRouter})` → `listTools()` / `callTool()`. All meta-tool handling and proxying; transport-independent so it is unit-tested |
| `meta-tools.ts` | The 6 meta-tool definitions (`META_TOOLS`) and zod argument schemas |
| `router.ts` | `ToolRouter` + `ServerConfig` type; ranks servers against a query; `reloadServersFromDisk()` |
| `skill-router.ts` | `SkillRouter` — same for file-based skills; `reloadFromDisk()`, `load()` |
| `scoring.ts` | Shared word-based scorer (keywords +2, description words +1, learned tool words up to +2, light stemming) |
| `tool-index.ts` | `ToolIndex` — persists each server's tool names/descriptions (`tool-index.json`) so `discover_tools` can route by them |
| `child-env.ts` | `buildChildEnv` — scopes the environment passed to stdio children (`inheritEnv`) |
| `config.ts` | zod validation for `servers.json` / `skills.json`; invalid entries are skipped and named |
| `process-manager.ts` | `ProcessManager` — stdio children and HTTP servers: handshake, tool-call proxying, per-server timeouts, activation dedup, collision detection, `onToolsChanged` callback |
| `oauth.ts` | PKCE OAuth for HTTP servers: discovery, DCR, loopback callback (state-checked), token storage (`0600`), forced refresh, in-flight dedup |
| `migrate-helpers.ts` | Shell detection / secret-file formatting and broker path resolution used by `migrate.mjs` |
| `version.ts` | `VERSION` (from package.json) and the `[context-broker]` log prefix |

### Request flow

1. Claude calls a meta-tool (`discover_tools`, `activate_server`, `deactivate_server`, `list_active_servers`, `discover_skill`, `load_skill`)
2. `broker.ts` validates the arguments (zod) and handles it — scoring via `ToolRouter`/`SkillRouter`, or delegating to `ProcessManager`
3. `ProcessManager` spawns the child (or opens the HTTP session) if not already active, does the MCP initialize handshake, caches the tool list, rejects tool-name collisions, and calls `onToolsChanged` → `index.ts` sends `notifications/tools/list_changed`
4. Subsequent `CallTool` requests for a non-meta tool are proxied through `ProcessManager.callTool()`
5. Auto-activation: if Claude calls an unknown tool, the best-scoring server is activated and the call retried; failures come back as `isError` results
6. All failures are returned with `isError: true`

### Config files

- `~/.config/context-broker/servers.json` — server registry (`{ servers: { name: { description, keywords, command, args, env, inheritEnv, autoActivate, toolTimeoutMs, migratedFrom, disabledPlugins } } }`; HTTP servers use `type`, `url`, `headers`, `oauth`)
- `~/.config/context-broker/skills.json` — skill registry (`{ skills: { name: { description, keywords, path, migratedFrom | plugin } } }`)
- `config/*.json` in the repo — **examples only**, never loaded implicitly

Config resolution: `--config` / `--skills` flag → `~/.config/context-broker/<file>`; otherwise an empty registry.

### Scripts (`scripts/`)

Plain `.mjs` files, no build step (except `migrate.mjs`, which imports `dist/migrate-helpers.js`, and `benchmark.mjs`, which imports `dist/meta-tools.js`).

- `lib/shared.mjs` — atomic writes + backups, `find` replacement, frontmatter parsing, `deriveEntry`, `splitSkillMd` / `mergeInstructions`, Cursor `${env:VAR}` conversion. Copied next to `session-sync.mjs` on install.
- `migrate.mjs` — reads servers from `~/.claude.json` / `~/.cursor/mcp.json` / `~/.config/opencode/opencode.json` (+ plugin `.mcp.json` files, labelled `plugin`), converts to broker format with a `migratedFrom` marker, extracts secrets (env and headers) to the shell file, registers skills/commands **in place** (no file moves), splits `SKILL.md`, adds the `SessionStart` hook, and registers the broker in the source client (`~/.claude.json`, Cursor `mcpServers`, OpenCode `mcp`). Every file it modifies is backed up (`.bak-<timestamp>`) and written atomically.
- `revert-migration.mjs` — inverse: writes servers back in each client's own format, re-enables exactly the plugins migrate disabled, merges `INSTRUCTIONS.md` back, removes the hook, removes the broker from `~/.claude.json` only when no migrated servers remain.
- `session-sync.mjs` — SessionStart hook; prunes stale entries, re-splits plugin skills, re-syncs skills while **preserving `migratedFrom`/`plugin`** markers. Never throws.
- `benchmark.mjs` — runs `claude -p` with four strategies (no MCP, all servers direct, broker idle, broker + all activated); single cold-cache turn, so cost figures overstate steady-state savings.

### Plugin skill split

Each `SKILL.md` is split into:
- `SKILL.md` — frontmatter plus a one-line `<!-- context-broker: … -->` pointer (what the harness injects per session)
- `INSTRUCTIONS.md` — body only (loaded on demand via `load_skill`)

The `SessionStart` hook re-runs the split after plugin updates. On revert, `INSTRUCTIONS.md` is merged back (the pointer line is dropped), reproducing the original file.
