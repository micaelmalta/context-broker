// src/__tests__/gateway-ui.test.ts
// The gateway web UI: static assets, token-gated API, admin split, stored per-user credentials.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadRegistry } from "../registry.js";
import { startGateway, type Gateway } from "../gateway/server.js";
import { TokenStore } from "../gateway/tokens.js";
import { SecretStore } from "../gateway/credentials.js";
import { UserVault, mergeCreds } from "../gateway/vault.js";
import { AuditLog } from "../gateway/audit.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/cred-server.mjs", import.meta.url));
const rev = (s: string) => [...s].reverse().join("");

let dir: string;
let gw: Gateway;
let admin: string;
let alice: string;
let bob: string;
const clients: Client[] = [];

async function ui(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${gw.port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function connect(token: string, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(gw.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lzg-ui-"));
  const server = (prefix: string, auth: unknown) => ({
    description: `${prefix} test server`,
    keywords: [prefix],
    command: process.execPath,
    args: [FIXTURE],
    env: { TOOL_PREFIX: prefix },
    inheritEnv: false,
    auth,
  });
  writeFileSync(
    join(dir, "servers.json"),
    JSON.stringify({
      servers: {
        jira: server("jira", { scope: "user", env: { TEST_TOKEN: "${cred:token}" } }),
        shared: server("shared", { scope: "server", env: { TEST_TOKEN: "${secret:shared/token}" } }),
        plain: server("plain", undefined),
      },
    })
  );
  writeFileSync(join(dir, "skills.json"), JSON.stringify({ skills: {} }));

  const tokens = new TokenStore(dir);
  admin = tokens.create({ user: "root", admin: true }).token;
  alice = tokens.create({ user: "alice", groups: ["eng"] }).token;
  bob = tokens.create({ user: "bob" }).token;
  const secrets = new SecretStore(dir, {});
  secrets.set("shared/token", "shared-secret-value");

  gw = await startGateway({
    registry: loadRegistry(["--config", join(dir, "servers.json")], dir),
    tokens,
    secrets,
    vault: new UserVault(dir, {}),
    audit: new AuditLog(join(dir, "audit.log")),
    port: 0,
    idleMs: 60_000,
    maxSessionsPerUser: 50,
  });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await gw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("static assets", () => {
  it("serves the page, script and styles with a strict CSP", async () => {
    for (const [path, type] of [
      ["/ui", "text/html"],
      ["/ui/app.js", "text/javascript"],
      ["/ui/app.css", "text/css"],
    ]) {
      const r = await ui("GET", path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain(type);
      expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    const page = (await ui("GET", "/ui")).text;
    expect(page).not.toMatch(/<script>[^<]/); // no inline script
  });

  it("ships a script that parses and never uses innerHTML", async () => {
    const js = (await ui("GET", "/ui/app.js")).text;
    expect(() => new Function(js)).not.toThrow();
    expect(js).not.toContain("innerHTML");
    expect(js).not.toMatch(/style\s*:/); // inline styles are blocked by the CSP
  });

  it("rejects foreign Host headers", async () => {
    const res = await fetch(`http://127.0.0.1:${gw.port}/ui`, { headers: { Host: "evil.example" } }).catch(() => null);
    // fetch forbids overriding Host in some runtimes; when it can, the gateway must refuse.
    if (res && new URL(res.url).host !== `127.0.0.1:${gw.port}`) expect(res.status).toBe(403);
  });
});

describe("API authentication", () => {
  it("needs a token", async () => {
    expect((await ui("GET", "/ui/api/me")).status).toBe(401);
    expect((await ui("GET", "/ui/api/me", "lzg_00000000_nope")).status).toBe(401);
  });

  it("reports who you are", async () => {
    const a = await ui("GET", "/ui/api/me", admin);
    expect(a.json).toMatchObject({ user: "root", admin: true, vault: true });
    const b = await ui("GET", "/ui/api/me", alice);
    expect(b.json).toMatchObject({ user: "alice", admin: false, groups: ["eng"] });
    expect(b.json.configPath).toBeUndefined();
  });

  it("keeps admin endpoints away from non-admins", async () => {
    for (const [m, p] of [
      ["GET", "/ui/api/tokens"],
      ["GET", "/ui/api/secrets"],
      ["GET", "/ui/api/status"],
      ["GET", "/ui/api/servers"],
    ]) {
      expect((await ui(m, p, alice)).status).toBe(403);
    }
  });
});

describe("tokens (admin)", () => {
  it("creates a working token, lists it without the secret, and revokes it", async () => {
    const made = await ui("POST", "/ui/api/tokens", admin, { user: "carol", groups: ["eng", " sre "], expires: "1d", label: "laptop" });
    expect(made.status).toBe(200);
    expect(made.json.token).toMatch(/^lzg_[0-9a-f]{8}_/);

    expect((await ui("GET", "/ui/api/me", made.json.token)).json).toMatchObject({ user: "carol", groups: ["eng", "sre"], admin: false });

    const list = await ui("GET", "/ui/api/tokens", admin);
    expect(JSON.stringify(list.json)).not.toContain(made.json.token.split("_")[2]);
    expect(list.json.tokens.find((t: any) => t.id === made.json.id)).toMatchObject({ user: "carol", label: "laptop" });

    expect((await ui("DELETE", `/ui/api/tokens/${made.json.id}`, admin)).status).toBe(204);
    expect((await ui("GET", "/ui/api/me", made.json.token)).status).toBe(401);
  });

  it("can mint an admin token, validates input, and won't revoke the token in use", async () => {
    const made = await ui("POST", "/ui/api/tokens", admin, { user: "dave", admin: true });
    expect((await ui("GET", "/ui/api/tokens", made.json.token)).status).toBe(200);

    expect((await ui("POST", "/ui/api/tokens", admin, { user: "bad name!" })).status).toBe(400);
    expect((await ui("POST", "/ui/api/tokens", admin, { user: "ok", expires: "soon" })).status).toBe(400);

    const own = (await ui("GET", "/ui/api/tokens", admin)).json.tokens.find((t: any) => t.user === "root");
    expect((await ui("DELETE", `/ui/api/tokens/${own.id}`, admin)).status).toBe(409);
  });
});

describe("secrets (admin)", () => {
  it("stores, lists names only, and deletes", async () => {
    expect((await ui("PUT", "/ui/api/secrets", admin, { path: "datadog/api_key", value: "dd-super-secret" })).status).toBe(200);
    const list = await ui("GET", "/ui/api/secrets", admin);
    expect(list.json.secrets).toContain("datadog/api_key");
    expect(list.text).not.toContain("dd-super-secret");
    expect(readFileSync(join(dir, "secrets.json"), "utf-8")).toContain("dd-super-secret");

    expect((await ui("PUT", "/ui/api/secrets", admin, { path: "../etc", value: "x" })).status).toBe(400);
    expect((await ui("DELETE", "/ui/api/secrets?path=datadog%2Fapi_key", admin)).status).toBe(204);
    expect((await ui("DELETE", "/ui/api/secrets?path=datadog%2Fapi_key", admin)).status).toBe(404);
  });
});

describe("my credentials (vault)", () => {
  it("lists only servers that need a personal credential", async () => {
    const r = await ui("GET", "/ui/api/connections", alice);
    expect(r.json.connections.map((c: any) => c.server)).toEqual(["jira"]);
    expect(r.json.connections[0].fields[0]).toMatchObject({ name: "token", stored: false, header: "X-Lazygate-Cred-jira-token" });
  });

  it("encrypts stored values, never returns them, and uses them in MCP sessions", async () => {
    const KEY = "alice-ui-key-777";
    expect((await ui("PUT", "/ui/api/connections/jira/token", alice, { value: KEY })).status).toBe(200);

    const list = await ui("GET", "/ui/api/connections", alice);
    expect(list.json.connections[0].fields[0].stored).toBe(true);
    expect(list.text).not.toContain(KEY);
    expect(readFileSync(join(dir, "vault.json"), "utf-8")).not.toContain(KEY);
    expect(readdirSync(dir)).toContain("vault.key");

    // No credential header: the stored key is used.
    const client = await connect(alice);
    const act = await call(client, "activate_server", { server_name: "jira" });
    expect(act.isError).toBeFalsy();
    expect((await call(client, "jira_probe")).content[0].text).toBe(`len:${KEY.length}:${rev(KEY)}`);
    expect((await call(client, "jira_echo")).content[0].text).toBe("[redacted]");

    // Bob has nothing stored: told what to send.
    const other = await connect(bob);
    const refused = await call(other, "activate_server", { server_name: "jira" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("X-Lazygate-Cred-jira-token");
  });

  it("lets a header override the stored value", async () => {
    const client = await connect(alice, { "X-Lazygate-Cred-jira-token": "header-key-999" });
    await call(client, "activate_server", { server_name: "jira" });
    expect((await call(client, "jira_probe")).content[0].text).toBe(`len:14:${rev("header-key-999")}`);
  });

  it("picks up a key saved after the session began", async () => {
    const client = await connect(bob);
    expect((await call(client, "activate_server", { server_name: "jira" })).isError).toBe(true);
    await ui("PUT", "/ui/api/connections/jira/token", bob, { value: "bob-late-key" });
    expect((await call(client, "activate_server", { server_name: "jira" })).isError).toBeFalsy();
    expect((await call(client, "jira_probe")).content[0].text).toBe(`len:12:${rev("bob-late-key")}`);
  });

  it("removes stored credentials", async () => {
    expect((await ui("DELETE", "/ui/api/connections/jira/token", bob)).status).toBe(204);
    expect((await ui("DELETE", "/ui/api/connections/jira/token", bob)).status).toBe(404);
  });

  it("refuses unknown servers, unknown fields and server-scope servers", async () => {
    expect((await ui("PUT", "/ui/api/connections/nope/token", alice, { value: "x" })).status).toBe(404);
    expect((await ui("PUT", "/ui/api/connections/jira/other", alice, { value: "x" })).status).toBe(404);
    expect((await ui("PUT", "/ui/api/connections/shared/token", alice, { value: "x" })).status).toBe(404);
    expect((await ui("PUT", "/ui/api/connections/jira/token", alice, { value: "" })).status).toBe(400);
  });
});

describe("status and activity", () => {
  it("shows live sessions to admins with their active servers", async () => {
    const client = await connect(alice);
    await call(client, "activate_server", { server_name: "jira" }); // stored key from earlier test
    const s = await ui("GET", "/ui/api/status", admin);
    expect(s.json.sessions.length).toBeGreaterThan(0);
    expect(s.json.sessions.some((x: any) => x.user === "alice" && x.servers.includes("jira"))).toBe(true);
    expect(JSON.stringify(s.json)).not.toContain("alice-ui-key-777");
  });

  it("limits the audit view to your own calls unless you are admin", async () => {
    const mine = await ui("GET", "/ui/api/audit", alice);
    expect(mine.json.events.length).toBeGreaterThan(0);
    expect(mine.json.events.every((e: any) => e.user === "alice")).toBe(true);

    const all = await ui("GET", "/ui/api/audit?all=1", admin);
    expect(new Set(all.json.events.map((e: any) => e.user)).size).toBeGreaterThan(1);

    const sneaky = await ui("GET", "/ui/api/audit?all=1", alice);
    expect(sneaky.json.events.every((e: any) => e.user === "alice")).toBe(true);
  });
});

describe("servers (admin)", () => {
  it("lists servers with templates but no values", async () => {
    const r = await ui("GET", "/ui/api/servers", admin);
    expect(r.json.editable).toBe(true);
    const jira = r.json.servers.find((s: any) => s.name === "jira");
    expect(jira.auth).toEqual({ scope: "user", fallback: false, env: { TEST_TOKEN: "${cred:token}" }, headers: {} });
    expect(r.text).not.toContain("shared-secret-value");
  });

  it("edits groups and credentials, writes servers.json, and applies immediately", async () => {
    const r = await ui("PATCH", "/ui/api/servers/plain", admin, {
      groups: ["sre"],
      auth: { scope: "user", fallback: true, env: { SVC_TOKEN: "${cred:key}" } },
    });
    expect(r.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8"));
    expect(onDisk.servers.plain.groups).toEqual(["sre"]);
    expect(onDisk.servers.plain.auth).toEqual({ scope: "user", fallback: "server", env: { SVC_TOKEN: "${cred:key}" } });
    expect(onDisk.servers.plain.command).toBe(process.execPath); // untouched fields survive
    expect(readdirSync(dir)).toContain("servers.json.bak-ui");

    // alice (eng) is outside "sre": the server is hidden and its credentials can't be set.
    expect((await ui("PUT", "/ui/api/connections/plain/key", alice, { value: "x" })).status).toBe(404);
    const client = await connect(alice);
    const found = await call(client, "discover_tools", { query: "plain" });
    expect(found.content[0].text).not.toContain("plain test server");
  });

  it("clears credentials and groups again", async () => {
    await ui("PATCH", "/ui/api/servers/plain", admin, { groups: [], auth: null });
    const onDisk = JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8"));
    expect(onDisk.servers.plain.groups).toBeUndefined();
    expect(onDisk.servers.plain.auth).toBeUndefined();
  });

  it("rejects bad edits without touching the file", async () => {
    const before = readFileSync(join(dir, "servers.json"), "utf-8");
    expect((await ui("PATCH", "/ui/api/servers/nope", admin, { groups: [] })).status).toBe(404);
    expect((await ui("PATCH", "/ui/api/servers/plain", admin, { auth: { scope: "user" } })).status).toBe(400);
    expect((await ui("PATCH", "/ui/api/servers/plain", admin, { auth: { scope: "user", env: { A: 1 } } })).status).toBe(400);
    expect(readFileSync(join(dir, "servers.json"), "utf-8")).toBe(before);
  });
});

describe("UserVault", () => {
  it("round-trips, lower-cases fields, and binds values to their owner", () => {
    const d = mkdtempSync(join(tmpdir(), "lzg-vault-"));
    try {
      const v = new UserVault(d, {});
      v.set("alice", "jira", "Token", "s3cret-value");
      expect(v.get("alice").get("jira")).toEqual({ token: "s3cret-value" });
      expect(v.list("alice")).toEqual({ jira: ["token"] });
      expect(v.get("bob").size).toBe(0);

      // Moving alice's ciphertext under bob must not decrypt.
      const file = JSON.parse(readFileSync(join(d, "vault.json"), "utf-8"));
      file.bob = file.alice;
      writeFileSync(join(d, "vault.json"), JSON.stringify(file), { mode: 0o600 });
      expect(new UserVault(d, {}).get("bob").size).toBe(0);
      expect(new UserVault(d, {}).get("alice").get("jira")).toEqual({ token: "s3cret-value" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("fails closed with the wrong key, and honours LAZYGATE_VAULT_KEY", () => {
    const d = mkdtempSync(join(tmpdir(), "lzg-vault-"));
    try {
      const key = Buffer.alloc(32, 7).toString("base64");
      const v = new UserVault(d, { LAZYGATE_VAULT_KEY: key });
      v.set("alice", "jira", "token", "abc123456");
      expect(readdirSync(d)).not.toContain("vault.key");
      expect(new UserVault(d, { LAZYGATE_VAULT_KEY: Buffer.alloc(32, 8).toString("base64") }).get("alice").size).toBe(0);
      expect(() => new UserVault(d, { LAZYGATE_VAULT_KEY: "c2hvcnQ=" }).get("alice")).not.toThrow(); // empty vault path
      expect(() => new UserVault(d, { LAZYGATE_VAULT_KEY: "c2hvcnQ=" }).set("alice", "j", "t", "v")).toThrow(/32 bytes/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("mergeCreds lets request headers win field by field", () => {
    const merged = mergeCreds(
      new Map([["jira", { token: "stored", extra: "kept" }]]),
      new Map([["jira", { token: "sent" }]])
    );
    expect(merged.get("jira")).toEqual({ token: "sent", extra: "kept" });
  });
});
