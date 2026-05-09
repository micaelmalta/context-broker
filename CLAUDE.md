# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc → dist/
npm run dev            # run from source via tsx (no build step)
npm run benchmark      # measure token savings across strategies
npm run migrate        # node scripts/migrate.mjs (pass args with --)
npm run revert-migration  # node scripts/revert-migration.mjs
```

No test suite currently exists.

## Architecture

context-broker is an MCP server that itself acts as a proxy. It exposes **6 meta-tools** to Claude Code instead of loading all real MCP server schemas upfront. Real servers and skills are loaded on demand.

### Source files (`src/`)

| File | Role |
|---|---|
| `index.ts` | Entry point. Wires the MCP SDK server, handles `ListTools` and `CallTool` requests, implements all 6 meta-tools, owns the auto-activation fallback |
| `router.ts` | `ToolRouter` — scores configured servers against a query using keyword + description matching |
| `skill-router.ts` | `SkillRouter` — same scoring logic for file-based skills |
| `process-manager.ts` | `ProcessManager` — spawns child MCP server processes, runs the JSON-RPC handshake, multiplexes tool calls to the right child, manages lifecycle |

### Request flow

1. Claude calls a meta-tool (`discover_tools`, `activate_server`, etc.)
2. `index.ts` handles it — either scoring via `ToolRouter`/`SkillRouter`, or delegating to `ProcessManager`
3. `ProcessManager` spawns the child process if not already active, does the MCP initialize handshake, and caches the tool list
4. Subsequent `CallTool` requests for a non-meta tool are proxied by `index.ts` through `ProcessManager.callTool()`
5. Auto-activation: if Claude calls an unknown tool, `index.ts` scores all servers against the tool name and activates the best match before retrying

### Config files

- `~/.config/context-broker/servers.json` — server registry (`{ servers: { name: { description, keywords, command, args, env, autoActivate } } }`)
- `~/.config/context-broker/skills.json` — skill registry (`{ skills: { name: { description, keywords, path } } }`)
- `config/servers.json` in the repo — bundled fallback, copied on install

Config resolution order: `--config` flag → `~/.config/context-broker/servers.json` → `./config/servers.json`.

### Scripts (`scripts/`)

Plain `.mjs` files, no build step needed.

- `migrate.mjs` — reads servers from `~/.claude.json` / `~/.cursor/mcp.json` / `~/.config/opencode/opencode.json`, converts to broker format, moves `~/.claude/skills/` to `~/.config/context-broker/skills/` (leaving symlinks), registers plugin skills from `~/.claude/plugins/cache/`, adds a `SessionStart` hook in `~/.claude/settings.json`
- `revert-migration.mjs` — inverse: writes servers back to source config's `mcpServers`, moves skills back, restores plugin `SKILL.md` files from `INSTRUCTIONS.md`, removes the `SessionStart` hook
- `benchmark.mjs` — runs `claude -p` with four strategies (no MCP, all servers direct, broker idle, broker + all activated) and reports token counts, cost, and savings

### Plugin skill split

When plugins are migrated, each `SKILL.md` is split:
- `SKILL.md` — frontmatter stub only (what the harness injects per session)
- `INSTRUCTIONS.md` — body only (loaded on demand via `load_skill`)

The `SessionStart` hook re-runs this split after plugin updates. On revert, `INSTRUCTIONS.md` is merged back into `SKILL.md`.
