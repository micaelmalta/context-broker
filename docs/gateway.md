# HTTP gateway (POC)

`lazygate serve` runs lazygate as an MCP server over Streamable HTTP, so several people (or several
clients) can share one instance. Each MCP session gets its own active servers, child processes and
credentials. It is built for a locally hosted proof of concept: plain HTTP on `127.0.0.1`, personal access
tokens for identity, no OIDC. The plan beyond the POC is in
[design/http-gateway.md](design/http-gateway.md) (on the design branch).

## Quick start

```bash
# 1. Create an access token for yourself (shown once)
npx lazygate token create --user alice --groups eng --expires 90d

# 2. Start the gateway (binds to 127.0.0.1:8787)
npx lazygate serve

# 3. Point a client at it
claude mcp add --transport http lazygate http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer lzg_..."
```

Or in `.mcp.json` / Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "lazygate": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${LAZYGATE_TOKEN}",
        "X-Lazygate-Cred-jira-token": "${JIRA_API_TOKEN}"
      }
    }
  }
}
```

The gateway reads the same `~/.config/lazygate/servers.json` (or `--config`) as stdio mode.

## Identity

Requests must carry `Authorization: Bearer lzg_<id>_<secret>`.

```bash
lazygate token create --user alice --groups eng,sre [--expires 90d] [--label ci]
lazygate token list
lazygate token revoke <id>
```

Only a hash of each token is stored (`~/.config/lazygate/gateway/tokens.json`, mode 0600). Revoking takes
effect immediately on a running gateway. The `Authorization` header identifies you to lazygate and is
**never forwarded** to upstream servers. A session id only works for the user who created it.

## Web UI

Open `http://127.0.0.1:8787/ui` and paste a token. It is a single page served by the gateway (no build
step, no extra dependencies, strict CSP, nothing stored in cookies — the token lives in
`sessionStorage` and is sent as a bearer header).

| Tab | Who | What |
|---|---|---|
| My credentials | everyone | Save, replace or remove your own API keys for servers with `auth.scope: "user"`. Stored encrypted; values are never shown again. A key sent in an `X-Lazygate-Cred-…` header still wins. |
| Activity | everyone (admins see all users) | Recent tool calls from the audit log |
| Sessions | admin | Live sessions and the servers each has active |
| Tokens | admin | Create (optionally `admin`, groups, expiry, label) and revoke tokens. The new token is shown once. |
| Secrets | admin | Set or delete server-level secrets (names only are listed) |
| Servers | admin | Edit a server's credential scope and templates, groups and auto-activate. Writes `servers.json` (previous file kept as `servers.json.bak-ui`) and applies immediately. |

Create the first admin from the CLI: `lazygate token create --user you --admin`. The page can't revoke
the token you're signed in with.

Stored user credentials live in `gateway/vault.json`, encrypted with AES-256-GCM and bound to the
user, server and field. The key is `LAZYGATE_VAULT_KEY` (base64, 32 bytes) or an auto-generated
`gateway/vault.key` (0600). Back both up together; without the key stored credentials are unreadable.

## Credentials

Each server says where its credentials come from, in `servers.json`:

```json
{
  "servers": {
    "jira": {
      "command": "jira-mcp",
      "inheritEnv": false,
      "auth": { "scope": "user", "env": { "JIRA_API_TOKEN": "${cred:token}" } }
    },
    "datadog": {
      "type": "http",
      "url": "https://mcp.datadoghq.com/v1/mcp",
      "auth": { "scope": "server", "headers": { "DD-API-KEY": "${secret:datadog/api_key}" } }
    },
    "wiki": {
      "command": "wiki-mcp",
      "auth": { "scope": "user", "fallback": "server", "env": { "WIKI_TOKEN": "${cred:token}" } },
      "groups": ["eng"]
    }
  }
}
```

| `auth.scope` | Credential | Where it comes from |
|---|---|---|
| `"user"` | the caller's own | request header `X-Lazygate-Cred-<server>-<field>` |
| `"server"` (default) | one for everybody | the gateway's secret store |
| `"user"` + `fallback: "server"` | the caller's, else the shared one | header, else secret `<server>/<field>` |

- `auth.env` (stdio servers) and `auth.headers` (HTTP servers) are templates. `${cred:field}` is a user
  credential, `${secret:path}` is a server secret.
- **User credentials** are either saved in the web UI or sent as headers, one per field: `X-Lazygate-Cred-jira-token: …` (a header overrides a saved value). The server
  name is matched against your configured servers, so hyphenated names (`request-mcp`) work. If one is
  missing, `activate_server` fails with the exact header to add, and `discover_tools` shows
  `⚠ needs credentials`.
- **Server secrets** live in `~/.config/lazygate/gateway/secrets.json` (0600) or in environment variables:

  ```bash
  printf '%s' "$KEY" | lazygate secret set datadog/api_key   # or LAZYGATE_SECRET_DATADOG_API_KEY=…
  lazygate secret list      # names only
  lazygate secret delete datadog/api_key
  ```

- **OAuth servers** (HTTP servers with `oauth` or that answer 401): with `auth.scope: "user"` each user's
  tokens are stored separately (`tokens/users/<user>/<server>.json`); otherwise the token is shared. The
  authorization flow still uses the loopback callback, so it works when the gateway runs on the machine of
  the person authorizing.

Rules the gateway enforces:

- A credential reaches only the server it is configured for, as that server's env var or header.
- A user can't override a server-scope credential by sending a header.
- Credential values are never re-expanded (a value that looks like `${HOME}` stays literal).
- Credential values are redacted from tool results, error messages and the audit log.
- Changing a credential starts a fresh process or HTTP session for that server; two users never share one.
- Use `inheritEnv: false` on gateway servers so a child never sees the gateway's own environment.

## Access policy

`"groups": ["sre"]` on a server hides it from everyone outside those groups: it is missing from
`discover_tools` and `activate_server` answers "Unknown server". Groups come from the token
(`token create --groups`). No `groups` means everyone.

## Operations

```
lazygate serve [--host 127.0.0.1] [--port 8787] [--config servers.json] [--skills skills.json]
               [--idle-timeout-min 30] [--max-sessions 100]
               [--allow-remote --allowed-host gw.example.com:443]
```

- Binds to loopback by default. Any other host needs `--allow-remote`, and you must put TLS in front.
  Requests whose `Host` or `Origin` isn't the gateway's own are rejected (DNS-rebinding protection).
- Sessions are closed after 30 minutes idle (and their servers are stopped), on `DELETE`, and on shutdown.
  Limits: 100 sessions in total, 10 per user.
- `GET /healthz` answers without auth.
- Audit log: `~/.config/lazygate/gateway/audit.log` (JSON lines: time, user, session, tool, server, ok,
  duration). Arguments and results are not logged.
- `autoActivate` servers start when a session finishes initializing, if their credentials resolve.

## What the POC does not do

- No OIDC / corporate SSO, no TLS termination, no public OAuth callback. The UI can't run an OAuth
  authorization for you yet (that still happens on the gateway host); the vault is a local encrypted file,
  not a database.
- Upstream processes are per session, not pooled across a user's sessions.
- Per-user skills, containers for stdio servers, rate limits and metrics.
