# Design: lazygate as a shared MCP HTTP gateway

Status: draft · Owner: @micaelmalta · Last updated: 2026-10-16

## Summary

Run lazygate as a hosted, multi-user MCP server over Streamable HTTP, so a team connects one URL
instead of configuring every MCP server locally. It keeps lazygate's core idea — a handful of
meta-tools, servers activated on demand — and adds user identity, per-user and shared credentials,
and per-user isolation for stdio servers. The existing stdio mode keeps working unchanged.

## POC status (implemented in #19)

A locally hosted POC covers a subset of this design, usage in [../gateway.md](../gateway.md):

| Design area | POC |
|---|---|
| Inbound auth | Personal access tokens only (`lazygate token …`). OIDC is deferred. |
| User credentials | Sent per request as `X-Lazygate-Cred-<server>-<field>` headers; nothing is stored for them. The encrypted store and connect pages (phases 4–5) are deferred. |
| Server credentials | `secrets.json` (0600) or `LAZYGATE_SECRET_*`, referenced as `${secret:path}`. |
| Per-user OAuth | Tokens stored per user and server; the authorization flow still uses the loopback callback. |
| Sessions | One `ProcessManager` per MCP session. No cross-session upstream pooling yet. |
| Policy, audit, redaction | `groups`, JSON-lines audit log, and redaction of credential values are in. |
| Transport security | Loopback only, Host/Origin checks. TLS and `--allow-remote` hardening are left to a proxy. |

## Goals

- One gateway URL per team; clients (Claude Code, Cursor, OpenCode) connect over Streamable HTTP.
- Inbound auth with either the corporate IdP (OAuth/OIDC, e.g. Okta) or gateway-issued personal tokens.
- Credentials for upstream servers at two levels, chosen per server:
  - **user** — each user's own OAuth token or API key;
  - **server** — one credential managed by an admin and used for everyone;
  - **user with server fallback**.
- Users connect their own accounts (OAuth consent, API key entry) without pasting secrets into chat.
- Stdio servers run on the gateway host, one process per user when credentials are per user.
- Admin policy: which groups may discover and use which servers.
- Auditable: who called which tool on which server, and when.

## Non-goals (for now)

- Replacing the local stdio mode. It stays the default for single-user setups.
- Servers that need the user's machine (local filesystem, local browser, local repos). They stay local.
- A full admin UI. Admin tasks are CLI + config files at first.
- Forwarding upstream elicitation / sampling requests to the client (later phase).

---

## Current state (what has to change)

| Area | Today | Needed |
|---|---|---|
| Client transport | stdio only (`index.ts`) | Streamable HTTP server transport, many concurrent sessions |
| State | One global `ProcessManager`: one active set, one `onToolsChanged` | Per-session active set and notifications; upstream connections pooled by (server, credential) |
| Identity | None (the OS user) | Authenticated user + groups on every request |
| Credentials | `~/.config/lazygate/tokens/<server>.json`; `${VAR}` from one environment | Store keyed by (user, server), encrypted at rest, shared server-level secrets |
| Upstream OAuth | Loopback callback on `127.0.0.1`, opens a local browser | Public callback on the gateway; consent link sent to the user |
| Stdio servers | One process per server, full or scoped env | One process per (user, server) where credentials are per user; limits and idle reaping |
| Policy / audit | None | Group-based server access; audit log |

What carries over unchanged: `broker.ts` (already transport-independent), `ToolRouter` / `SkillRouter`
/ scoring, the tool index, config validation, the HTTP-upstream client code (SSE parsing, session
handling, 401 refresh), and `buildChildEnv`.

---

## Architecture

```
 Claude Code / Cursor ──HTTPS (Streamable HTTP, Bearer)──►  lazygate gateway
                                                        ┌──────────────────────────────┐
                                                        │ Auth: OIDC JWT | personal PAT│
                                                        │ Identity + group policy      │
                                                        │ Session (per MCP session)    │
                                                        │  └ broker (meta-tools)       │
                                                        │ UpstreamPool                 │
                                                        │  ├ HTTP clients              │
                                                        │  └ stdio processes           │
                                                        │ CredentialStore (encrypted)  │
                                                        │ Connect pages / OAuth cb     │
                                                        │ Audit log, metrics           │
                                                        └──────┬──────────────┬────────┘
                                                               │              │
                                                    remote MCP servers   stdio children
                                                    (GitHub, Slack, …)   (per user)
```

### Sessions

A `Session` replaces the global state in `ProcessManager`:

```ts
interface Session {
  id: string;                         // MCP-Session-Id
  user: UserIdentity;                 // { id, email, groups, authMethod }
  active: Map<string, UpstreamHandle>;// servers this session activated
  notifyToolsChanged(): void;         // sends tools/list_changed on this session only
}
```

- `createBroker` gets a session instead of the global manager. `listTools` returns the meta-tools plus
  the tools of *this session's* active servers.
- A session is bound to the user who created it. A request carrying a session id with a different
  identity is rejected (`404`, forcing a new session) — session ids are not credentials.
- Sessions expire after inactivity (default 30 min); their upstream handles are released.
- In stdio mode there is exactly one session with a local "user", so behaviour is unchanged.

### Upstream pool

`UpstreamPool` owns connections; sessions hold references.

- **Pool key** = `server name + credential key`. The credential key is `server` for server-level
  credentials and `user:<id>` for user-level ones. Two users with their own GitHub tokens never share
  a connection.
- **HTTP upstreams**: one MCP client session per pool key. Upstream MCP sessions can be stateful, so a
  server-level HTTP upstream is still shared only if the server is marked `shareable: true`; otherwise
  it is one per (user, server).
- **stdio upstreams**: one process per pool key, so per-user credentials mean per-user processes. A
  server-level stdio server may be shared across users only with `shareable: true` (stateless servers).
- Reference-counted; idle connections are closed after `idleTimeoutMs` (default 10 min).
- Limits: max processes per user, max total processes, per-call timeout (existing `toolTimeoutMs`),
  max response size.
- Tool-name collision checks stay per session (two users may activate different sets).

### Request flow

1. The client sends `initialize` with `Authorization: Bearer …`.
2. The gateway authenticates the token (OIDC JWT or PAT), resolves `UserIdentity`, creates a `Session`.
3. `discover_tools` ranks only the servers the user's groups are allowed to use, and shows for each
   whether the user is connected (`● active`, `○ ready`, `⚠ needs connect`).
4. `activate_server` resolves credentials for (user, server):
   - found → acquire a pool handle, expose the tools, send `tools/list_changed` to this session;
   - missing → return a result with a **connect link** (and a URL-mode elicitation where the client
     supports it), e.g. "Connect GitHub to continue: https://gw.example.com/connect/github?s=…".
5. Proxied tool calls go to the pool handle; every call is written to the audit log.
6. A `401` from an upstream triggers a forced refresh of *that user's* token (existing logic), then
   one retry; if refresh fails the user gets a reconnect link.

---

## Inbound authentication

Both methods produce the same `UserIdentity`; everything downstream is method-agnostic.

### 1. Corporate IdP (OAuth 2.1 / OIDC)

- The gateway is an OAuth **resource server**. It serves
  `/.well-known/oauth-protected-resource` (RFC 9728) pointing at the IdP, and answers unauthenticated
  requests with `401` + `WWW-Authenticate: Bearer resource_metadata=…`, which MCP clients already
  understand (lazygate's own client does this today).
- Tokens are validated locally: signature via the IdP's JWKS (cached), `iss`, `aud` = the gateway's
  resource URI, `exp`/`nbf`, required scope (e.g. `lazygate`).
- Identity: `sub` → user id, `email`, `groups` claim → groups (claim name configurable).
- The client registers with the IdP through DCR where the IdP allows it, or uses a pre-registered
  public client id published by the gateway.

### 2. Gateway-issued personal access tokens (PATs)

For CI, headless agents and clients that can't do OAuth:

```
lazygate token create --user alice@example.com --groups eng --expires 90d   # prints the token once
lazygate token list   --user alice@example.com
lazygate token revoke <id>
```

- Format `lzg_<id>_<secret>`; only a hash of the secret (SHA-256 with a server-side pepper) is stored.
- Each token has an owner, groups (or "inherit from directory"), expiry, optional server allowlist,
  and `lastUsedAt`.
- Users can later mint their own through the web UI after an OIDC login.

### Never pass the inbound token upstream

The token a client presents to lazygate is never forwarded to an upstream server (MCP spec:
no token passthrough). Where the upstream trusts the same IdP, lazygate can obtain a token for it via
OAuth token exchange (RFC 8693) — an optional `type: "token-exchange"` credential (later phase).

---

## Credentials

### Per-server configuration

```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "scope": "user", "type": "oauth" }
    },
    "datadog": {
      "type": "http",
      "url": "https://mcp.datadoghq.com/v1/mcp",
      "auth": {
        "scope": "server",
        "type": "apiKey",
        "headers": { "DD-API-KEY": "${secret:datadog/api_key}", "DD-APPLICATION-KEY": "${secret:datadog/app_key}" }
      }
    },
    "jira": {
      "command": "jira-mcp",
      "inheritEnv": false,
      "auth": {
        "scope": "user",
        "fallback": "server",
        "type": "apiKey",
        "fields": [{ "name": "token", "label": "Jira API token", "help": "https://id.atlassian.com/manage/api-tokens" }],
        "env": { "JIRA_API_TOKEN": "${cred:token}", "JIRA_URL": "https://example.atlassian.net" }
      }
    },
    "snowflake": {
      "command": "snowflake-mcp",
      "auth": { "scope": "server", "type": "oauth-client-credentials", "tokenUrl": "…", "clientId": "…",
                "clientSecret": "${secret:snowflake/client_secret}" }
    }
  },
  "policy": {
    "github":    { "groups": ["eng"] },
    "snowflake": { "groups": ["data", "sre"] }
  }
}
```

| `auth.type` | Where the value goes | User-level | Server-level |
|---|---|---|---|
| `oauth` | `Authorization: Bearer` (HTTP) or `${cred:access_token}` (stdio env) | consent flow per user | admin completes the flow once (service account) |
| `apiKey` | the `headers` / `env` templates | user enters it on the connect page | admin sets it with `lazygate secret set` |
| `oauth-client-credentials` | `Authorization: Bearer` / env | — | client-credentials grant, cached and refreshed |
| `none` | — | — | — |

Template variables:

- `${secret:path}` — a server-level secret from the secret store (never from `servers.json`).
- `${cred:field}` — a field of the credential resolved for this request (user's, or the server fallback).
- `${VAR}` — process environment, as today. Allowed for non-secret values; in gateway mode lazygate
  warns when a `${VAR}` looks like a secret, to steer secrets into the store.

**Resolution order** for `scope: "user"`: the user's credential → server-level credential if
`fallback: "server"` → "needs connect". For `scope: "server"`: the server credential → error that
names the missing secret (users can't fix it, so no connect link).

### CredentialStore

```ts
interface CredentialStore {
  get(owner: Owner, server: string): Promise<Credential | null>;   // Owner = { user: id } | "server"
  put(owner: Owner, server: string, cred: Credential): Promise<void>;
  delete(owner: Owner, server: string): Promise<void>;
  list(owner: Owner): Promise<Array<{ server: string; type: string; updatedAt: string }>>;
}
```

Backends:

- `file` — today's `~/.config/lazygate/tokens/` layout, extended with an owner level. Default for
  stdio mode; existing tokens migrate as owner `local`.
- `sqlite` / `postgres` — gateway mode. Credentials are encrypted with envelope encryption: a data
  key per record, wrapped by a KMS key (AWS KMS / GCP KMS) or a local master key for dev. Secrets
  never appear in logs, errors or tool results.
- `vault` (optional) — for teams that already run HashiCorp Vault.

OAuth tokens carry `{ access_token, refresh_token, expires_at, scope, resource }` and stay bound to
the server URL they were issued for (as today). Refresh is serialized per (user, server) — the
existing in-flight dedup, keyed by owner as well.

### Connecting a user's account

Web routes served by the gateway (same host, behind the same inbound auth via an OIDC login cookie):

- `GET /connect` — the user's connections: connected, expired, missing; disconnect buttons.
- `GET /connect/<server>` — OAuth servers: starts authorization code + PKCE with the gateway's public
  callback; API-key servers: a form built from `auth.fields`.
- `GET /oauth/callback/<server>` — checks `state` (bound to user + server + session, single use,
  10-minute expiry), exchanges the code, stores the token, then notifies the waiting session so the
  pending `activate_server` can be retried.

Connect links handed to the model are short-lived, single-use and bound to the user, so a link
leaked in a transcript can't be used by someone else.

New meta-tools:

- `connect_server(server_name)` — returns the connect link (or triggers URL-mode elicitation).
- `disconnect_server(server_name)` — deletes the user's credential and closes their pool handle.
- `list_active_servers` additionally shows connection state.

Dynamic client registration and remembered clients (`clients/`) become server-level records — one
OAuth client per upstream per gateway, not per user.

---

## Stdio servers on the gateway

- **One process per (user, server)** for user-level credentials; the credential is injected through
  `env` templates with `inheritEnv: false` forced in gateway mode, so a child never sees the gateway's
  own environment or other users' secrets.
- **Isolation**: each child runs in its own working directory (`/var/lib/lazygate/users/<id>/<server>`),
  with resource limits (memory, CPU, open files) via cgroups or `prlimit`, optionally as an unprivileged
  OS user or inside a container (`runtime: "process" | "docker"`). Container runtime is a later phase;
  the interface is designed so it can be swapped in.
- **Lifecycle**: idle reaping, a per-user process cap, a global cap with a clear error when hit,
  and crash handling as today (pending calls rejected, `tools/list_changed`).
- **Startup cost**: `npx`-style servers are slow on first launch; the gateway image pre-installs the
  allowed servers, and `servers.json` in gateway mode rejects `npx -y` of arbitrary packages unless
  allowlisted.
- Servers that need a user's local machine are marked `local: true` and hidden in gateway mode.

---

## Discovery, policy and the tool index

- `discover_tools` filters by policy *before* scoring, so users don't learn about servers they can't use.
- The learned tool index stays per server (tool lists rarely differ between users). It is only
  updated from activations by users allowed to use the server.
- Skills: `skills.json` in gateway mode points at a skills directory on the gateway (or a git repo
  synced on a schedule). Per-user skills are out of scope for the first version.

---

## Security considerations

| Threat | Mitigation |
|---|---|
| Session hijack via a leaked `MCP-Session-Id` | Session bound to identity; every request re-authenticated |
| Confused deputy: user A's request runs with user B's credentials | Pool keyed by credential owner; no cross-user sharing unless `shareable` and server-level |
| Token passthrough | Inbound token never forwarded; token exchange for same-IdP upstreams |
| OAuth callback CSRF / code injection | `state` bound to user + server, single use, PKCE, exact redirect URI |
| Leaked connect links | Short-lived, single use, bound to the user |
| Secrets at rest | Envelope encryption with KMS; `0600` / DB access limited to the service |
| Secrets in output | Redaction of known secret values in logs, errors and tool results |
| Malicious or compromised stdio server | `inheritEnv: false`, per-user process, resource limits, allowlisted commands; containers later |
| Prompt injection from tool results | Out of scope for the gateway; results are passed through unchanged, as today |
| Abuse / runaway agents | Rate limits per user and per server; max concurrent calls; per-call timeout |

---

## Observability

- **Audit log** (append-only, JSON lines or DB table): timestamp, user, auth method, session, server,
  tool, outcome, duration, bytes. Arguments and results are *not* logged by default.
- **Metrics** (Prometheus): sessions, active upstreams by type, process count, call latency and error
  rate per server, OAuth refresh failures, policy denials.
- Health endpoints: `/healthz` (process up), `/readyz` (store and IdP JWKS reachable).

---

## Deployment

- `lazygate serve --http --port 8787 --config /etc/lazygate/servers.json --store postgres://…`
- Container image with Node and the allowlisted MCP servers pre-installed; Helm chart.
- Behind TLS termination. The gateway's public base URL is configured explicitly (used for the
  resource metadata and OAuth callbacks); `Host` headers are not trusted.
- Horizontal scaling: sessions are sticky (stdio children and upstream sessions are in memory), so the
  load balancer routes by `MCP-Session-Id`. Credentials, PATs and audit are in the shared store, so any
  replica can serve a new session.

---

## Compatibility

- `lazygate` with no `serve` subcommand is the current stdio mode: one local session, file store,
  current config. Existing `servers.json` files work as-is; `auth` is optional and, when absent,
  behaves like today (`headers`, `env`, `oauth` fields).
- `migrate` / `revert` are unchanged (they target local mode).
- Existing OAuth tokens in `tokens/` are read as owner `local`.

---

## Phases

Each phase ships on its own and leaves stdio mode working.

| # | Deliverable | Done when |
|---|---|---|
| 0 | **Session refactor.** Split `ProcessManager` into `Session` + `UpstreamPool`; `createBroker` takes a session. | No behaviour change; all tests pass; new tests for two sessions with independent active sets and notifications. |
| 1 | **HTTP transport, single tenant.** `lazygate serve --http` with Streamable HTTP, a static bearer token, sticky sessions, `/healthz`. | Claude Code and Cursor connect over HTTP; two clients get independent active sets. |
| 2 | **Credential model.** `auth` config, `${secret:}` / `${cred:}` templates, `CredentialStore` with the file backend, `lazygate secret set`. | Server-level and user-level credentials work with a single local user; existing tokens migrate. |
| 3 | **Identity and policy.** OIDC resource server (JWKS, audience, groups), PATs (`lazygate token …`), group policy, session-identity binding, audit log. | Two users with different groups see different servers; PAT and OIDC both work; denials are audited. |
| 4 | **User connections.** Encrypted DB store, `/connect` pages, public OAuth callback, connect links + URL elicitation, `connect_server` / `disconnect_server`. | A user connects GitHub (OAuth) and Jira (API key) from Claude Code without touching config; tokens refresh per user. |
| 5 | **Multi-user stdio and operations.** Per-(user, server) processes, limits, idle reaping, command allowlist, rate limits, metrics, container image, Helm chart. | Load test with N users × M servers stays within limits; a crashed child affects only its user. |
| 6 | **Later.** Container runtime for stdio, token exchange, upstream elicitation/sampling forwarding, admin UI, per-user skills. | — |

---

## Open questions

1. **IdP specifics.** Which IdP and which claim carries groups? Does it support DCR, or do we publish a
   fixed public client id?
2. **Secret store.** Postgres + KMS, or an existing Vault? Which cloud?
3. **Hosting.** Where does the gateway run (EKS?), and is a single replica acceptable for the first
   team rollout (avoids sticky-session work in phase 1)?
4. **Shared vs per-user upstreams.** Which current servers are safe to mark `shareable`?
5. **Build vs. adopt.** Should phases 3–5 sit on an existing gateway (Docker MCP Gateway, agentgateway,
   IBM ContextForge) with lazygate providing the lazy discovery layer on top? Worth a short spike before
   phase 3.
6. **Client support.** Which clients in use support URL-mode elicitation; the connect-link fallback has
   to be good enough on its own.
