// src/__tests__/gateway-http.test.ts
// End-to-end: a real HTTP gateway on an ephemeral port, driven by the SDK's own HTTP client.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadRegistry } from "../registry.js";
import { startGateway, type Gateway } from "../gateway/server.js";
import { TokenStore } from "../gateway/tokens.js";
import { SecretStore } from "../gateway/credentials.js";
import { AuditLog } from "../gateway/audit.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/cred-server.mjs", import.meta.url));
const ALICE_KEY = "alice-jira-key-123";
const BOB_KEY = "bob-jira-key-456";
const SHARED_SECRET = "shared-secret-value";

let dir: string;
let gw: Gateway;
let deps: { registry: ReturnType<typeof loadRegistry>; tokens: TokenStore; secrets: SecretStore };
let aliceToken: string;
let bobToken: string;
const clients: Client[] = [];

const rev = (s: string) => [...s].reverse().join("");
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

async function connect(token: string, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(gw.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function rawPost(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: gw.port, path, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lzg-gw-"));
  const server = (prefix: string, auth: unknown, extra: Record<string, unknown> = {}) => ({
    description: `${prefix} test server`,
    keywords: [prefix],
    command: process.execPath,
    args: [FIXTURE],
    env: { TOOL_PREFIX: prefix },
    inheritEnv: false,
    auth,
    ...extra,
  });
  writeFileSync(
    join(dir, "servers.json"),
    JSON.stringify({
      servers: {
        jira: server("jira", { scope: "user", env: { TEST_TOKEN: "${cred:token}" } }),
        shared: server("shared", { scope: "server", env: { TEST_TOKEN: "${secret:shared/token}" } }),
        fallbacky: server("fallbacky", { scope: "user", fallback: "server", env: { TEST_TOKEN: "${cred:token}" } }),
        sre: server("sre", undefined, { groups: ["sre"] }),
      },
    })
  );
  writeFileSync(join(dir, "skills.json"), JSON.stringify({ skills: {} }));

  const tokens = new TokenStore(dir);
  aliceToken = tokens.create({ user: "alice", groups: ["eng"] }).token;
  bobToken = tokens.create({ user: "bob", groups: ["sre"] }).token;

  const secrets = new SecretStore(dir, {});
  secrets.set("shared/token", SHARED_SECRET);
  secrets.set("fallbacky/token", "fallback-secret-789");

  deps = { registry: loadRegistry(["--config", join(dir, "servers.json")], dir), tokens, secrets };
  gw = await startGateway({
    ...deps,
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

describe("authentication and transport", () => {
  it("rejects requests without a valid token", async () => {
    const none = await rawPost("/mcp", {}, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(none.status).toBe(401);
    const bad = await rawPost("/mcp", { Authorization: "Bearer lzg_deadbeef_notarealsecretnotarealsecret" }, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(bad.status).toBe(401);
  });

  it("rejects a Host header that isn't ours (DNS rebinding)", async () => {
    const r = await rawPost("/mcp", { Authorization: `Bearer ${aliceToken}`, Host: "evil.example" }, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r.status).toBe(403);
  });

  it("serves /healthz without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${gw.port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("exposes the meta-tools over HTTP", async () => {
    const { client } = await connect(aliceToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["discover_tools", "activate_server", "list_active_servers", "deactivate_server"])
    );
  });

  it("binds a session to the user who created it", async () => {
    const { transport } = await connect(aliceToken);
    const sid = transport.sessionId!;
    const stolen = await rawPost(
      "/mcp",
      { Authorization: `Bearer ${bobToken}`, "Mcp-Session-Id": sid },
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }
    );
    expect(stolen.status).toBe(404);
  });
});

describe("sessions are independent", () => {
  it("keeps active servers per session", async () => {
    const a = (await connect(aliceToken, { "X-Lazygate-Cred-jira-token": ALICE_KEY })).client;
    const b = (await connect(aliceToken, { "X-Lazygate-Cred-jira-token": ALICE_KEY })).client;

    expect(text(await call(a, "activate_server", { server_name: "jira" }))).toMatch(/Activated "jira"/);
    expect(text(await call(a, "list_active_servers"))).toMatch(/jira/);
    expect(text(await call(b, "list_active_servers"))).toMatch(/No servers currently active/);
  });
});

describe("user-level credentials (headers)", () => {
  it("passes each user's own key to their own process", async () => {
    const alice = (await connect(aliceToken, { "X-Lazygate-Cred-jira-token": ALICE_KEY })).client;
    const bob = (await connect(bobToken, { "X-Lazygate-Cred-jira-token": BOB_KEY })).client;
    await call(alice, "activate_server", { server_name: "jira" });
    await call(bob, "activate_server", { server_name: "jira" });

    expect(text(await call(alice, "jira_probe"))).toBe(`len:${ALICE_KEY.length}:${rev(ALICE_KEY)}`);
    expect(text(await call(bob, "jira_probe"))).toBe(`len:${BOB_KEY.length}:${rev(BOB_KEY)}`);
  });

  it("names the header to send when the credential is missing", async () => {
    const { client } = await connect(aliceToken);
    const r = await call(client, "activate_server", { server_name: "jira" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("X-Lazygate-Cred-jira-token");

    const discover = text(await call(client, "discover_tools", { query: "jira" }));
    expect(discover).toMatch(/needs credentials/);
    expect(discover).toContain("X-Lazygate-Cred-jira-token");
  });

  it("redacts credential values from tool results", async () => {
    const { client } = await connect(aliceToken, { "X-Lazygate-Cred-jira-token": ALICE_KEY });
    await call(client, "activate_server", { server_name: "jira" });
    const r = await call(client, "jira_echo");
    expect(text(r)).toBe("[redacted]");
    expect(JSON.stringify(r)).not.toContain(ALICE_KEY);
  });

  it("falls back to the server-level secret when the user sent nothing", async () => {
    const { client } = await connect(aliceToken);
    await call(client, "activate_server", { server_name: "fallbacky" });
    expect(text(await call(client, "fallbacky_probe"))).toBe(`len:19:${rev("fallback-secret-789")}`);
  });
});

describe("server-level credentials", () => {
  it("uses the gateway secret and ignores a user-supplied override", async () => {
    const { client } = await connect(aliceToken, { "X-Lazygate-Cred-shared-token": "user-tries-to-override" });
    await call(client, "activate_server", { server_name: "shared" });
    expect(text(await call(client, "shared_probe"))).toBe(`len:${SHARED_SECRET.length}:${rev(SHARED_SECRET)}`);
  });
});

describe("group policy", () => {
  it("hides servers from users outside the group", async () => {
    const { client } = await connect(aliceToken); // eng
    expect(text(await call(client, "discover_tools", { query: "sre test server" }))).not.toMatch(/\bsre\b \(score/);
    const r = await call(client, "activate_server", { server_name: "sre" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown server/);
  });

  it("lets group members use them", async () => {
    const { client } = await connect(bobToken); // sre
    expect(text(await call(client, "activate_server", { server_name: "sre" }))).toMatch(/Activated "sre"/);
  });
});

describe("audit log", () => {
  it("records calls without credential values", async () => {
    const { client } = await connect(aliceToken, { "X-Lazygate-Cred-jira-token": "audit-secret-value-1" });
    await call(client, "activate_server", { server_name: "jira" });
    await call(client, "jira_echo");
    const log = readFileSync(join(dir, "audit.log"), "utf-8");
    expect(log).toContain('"tool":"activate_server"');
    expect(log).toContain('"user":"alice"');
    expect(log).toContain('"server":"jira"');
    expect(log).not.toContain("audit-secret-value-1");
  });
});

describe("limits and lifecycle", () => {
  const extra: Gateway[] = [];
  afterAll(async () => {
    await Promise.all(extra.map((g) => g.close()));
  });

  async function another(overrides: Partial<Parameters<typeof startGateway>[0]>): Promise<Gateway> {
    const g = await startGateway({ ...deps, audit: new AuditLog(null), port: 0, ...overrides });
    extra.push(g);
    return g;
  }

  it("caps concurrent sessions per user", async () => {
    const g = await another({ maxSessionsPerUser: 1 });
    const open = async () => {
      const t = new StreamableHTTPClientTransport(new URL(g.url), { requestInit: { headers: { Authorization: `Bearer ${aliceToken}` } } });
      const c = new Client({ name: "t", version: "1" });
      await c.connect(t);
      clients.push(c);
      return c;
    };
    await open();
    await expect(open()).rejects.toThrow(/Too many sessions|503/);
    expect(g.sessionCount()).toBe(1);
  });

  it("closes a session (and its servers) when the client terminates it", async () => {
    const g = await another({});
    const t = new StreamableHTTPClientTransport(new URL(g.url), {
      requestInit: { headers: { Authorization: `Bearer ${bobToken}` } },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    await call(c, "activate_server", { server_name: "sre" });
    expect(g.sessionCount()).toBe(1);

    await t.terminateSession();
    await new Promise((r) => setTimeout(r, 200));
    expect(g.sessionCount()).toBe(0);
    await c.close().catch(() => undefined);
  });

  it("closes idle sessions", async () => {
    const g = await another({ idleMs: 1000 });
    const t = new StreamableHTTPClientTransport(new URL(g.url), {
      requestInit: { headers: { Authorization: `Bearer ${aliceToken}` } },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    expect(g.sessionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 3200));
    expect(g.sessionCount()).toBe(0);
    await c.close().catch(() => undefined);
  }, 10_000);
});
