// src/__tests__/gateway-units.test.ts
// Credentials, secrets, tokens, redaction and policy — the pieces the HTTP gateway is built from.

import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, statSync, readFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CredentialResolver,
  MissingCredentialError,
  SecretStore,
  canAccess,
  credHeaderName,
  extractUserCreds,
  secretEnvName,
} from "../gateway/credentials.js";
import { TokenStore, bearerToken, parseDuration } from "../gateway/tokens.js";
import { Redactor } from "../gateway/redact.js";
import { tokenPath } from "../oauth.js";
import type { ServerConfig } from "../router.js";

let dir: string | undefined;
const tmp = () => (dir = mkdtempSync(join(tmpdir(), "lzg-unit-")));
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const server = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "",
  keywords: [],
  command: "node",
  autoActivate: false,
  ...o,
});

describe("extractUserCreds", () => {
  it("groups credentials by server and field, case-insensitively", () => {
    const creds = extractUserCreds(
      { "X-Lazygate-Cred-Jira-Token": "abc", "x-lazygate-cred-jira-url": "https://j", authorization: "Bearer x" },
      ["jira", "github"]
    );
    expect(creds.get("jira")).toEqual({ token: "abc", url: "https://j" });
    expect(creds.has("github")).toBe(false);
  });

  it("handles hyphenated server names and prefers the longest match", () => {
    const creds = extractUserCreds(
      { "x-lazygate-cred-request-mcp-api-key": "k1", "x-lazygate-cred-request-token": "k2" },
      ["request", "request-mcp"]
    );
    expect(creds.get("request-mcp")).toEqual({ "api-key": "k1" });
    expect(creds.get("request")).toEqual({ token: "k2" });
  });

  it("ignores unknown servers, empty values and bare server headers", () => {
    const creds = extractUserCreds(
      { "x-lazygate-cred-nope-token": "x", "x-lazygate-cred-jira-token": "", "x-lazygate-cred-jira-": "x" },
      ["jira"]
    );
    expect(creds.size).toBe(0);
  });

  it("names headers the way users should send them", () => {
    expect(credHeaderName("jira", "token")).toBe("X-Lazygate-Cred-jira-token");
  });
});

describe("SecretStore", () => {
  it("prefers the environment, then the file; files are 0600", () => {
    const d = tmp();
    const store = new SecretStore(d, { LAZYGATE_SECRET_DATADOG_API_KEY: "from-env" });
    store.set("datadog/api_key", "from-file");
    store.set("jira/token", "file-only");
    expect(store.get("datadog/api_key")).toBe("from-env");
    expect(store.get("jira/token")).toBe("file-only");
    expect(store.get("missing")).toBeUndefined();
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("lists names only and deletes", () => {
    const store = new SecretStore(tmp(), {});
    store.set("b/x", "v1");
    store.set("a/y", "v2");
    expect(store.list()).toEqual(["a/y", "b/x"]);
    expect(store.delete("a/y")).toBe(true);
    expect(store.delete("a/y")).toBe(false);
    expect(store.list()).toEqual(["b/x"]);
  });

  it("derives environment names from paths", () => {
    expect(secretEnvName("datadog/api_key")).toBe("LAZYGATE_SECRET_DATADOG_API_KEY");
  });
});

describe("CredentialResolver", () => {
  const secrets = () => {
    const s = new SecretStore(tmp(), {});
    s.set("shared/token", "shared-secret");
    s.set("jira/token", "jira-fallback");
    return s;
  };

  it("does nothing for servers without auth templates", () => {
    const r = new CredentialResolver(secrets());
    expect(r.resolve("plain", server(), new Map())).toEqual({ runtime: undefined, secretValues: [] });
  });

  it("builds env and headers from user credentials and secrets", () => {
    const r = new CredentialResolver(secrets());
    const cfg = server({
      auth: {
        scope: "user",
        env: { JIRA_TOKEN: "${cred:token}" },
        headers: { Authorization: "Bearer ${cred:token}", "X-Org": "${secret:shared/token}" },
      },
    });
    const { runtime, secretValues } = r.resolve("jira", cfg, new Map([["jira", { token: "user-key-1" }]]));
    expect(runtime).toEqual({
      env: { JIRA_TOKEN: "user-key-1" },
      headers: { Authorization: "Bearer user-key-1", "X-Org": "shared-secret" },
    });
    expect(secretValues).toEqual(expect.arrayContaining(["user-key-1", "shared-secret"]));
  });

  it("never re-expands a credential value that looks like a template", () => {
    const r = new CredentialResolver(secrets());
    const cfg = server({ auth: { scope: "user", env: { T: "${cred:token}" } } });
    const { runtime } = r.resolve("jira", cfg, new Map([["jira", { token: "${AWS_SECRET_ACCESS_KEY}" }]]));
    expect(runtime!.env!.T).toBe("${AWS_SECRET_ACCESS_KEY}");
  });

  it("reports missing user credentials as the header to send", () => {
    const r = new CredentialResolver(secrets());
    const cfg = server({ auth: { scope: "user", env: { T: "${cred:token}", U: "${cred:url}" } } });
    expect(r.missing("jira", cfg, new Map())).toEqual(["X-Lazygate-Cred-jira-token", "X-Lazygate-Cred-jira-url"]);
    try {
      r.resolve("jira", cfg, new Map());
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingCredentialError);
      expect((err as Error).message).toContain("X-Lazygate-Cred-jira-token");
    }
  });

  it("falls back to the server secret only when asked to", () => {
    const r = new CredentialResolver(secrets());
    const withFallback = server({ auth: { scope: "user", fallback: "server", env: { T: "${cred:token}" } } });
    expect(r.resolve("jira", withFallback, new Map()).runtime!.env!.T).toBe("jira-fallback");
    // …but a user's own value always wins
    expect(r.resolve("jira", withFallback, new Map([["jira", { token: "mine" }]])).runtime!.env!.T).toBe("mine");

    const noFallback = server({ auth: { scope: "user", env: { T: "${cred:token}" } } });
    expect(r.missing("jira", noFallback, new Map())).toHaveLength(1);
  });

  it("ignores user-sent values for server-scope credentials", () => {
    const r = new CredentialResolver(secrets());
    const cfg = server({ auth: { scope: "server", env: { T: "${secret:shared/token}", V: "${cred:token}" } } });
    // `${cred:token}` on a server-scope server resolves from secret "shared/token", never from headers
    const { runtime } = r.resolve("shared", cfg, new Map([["shared", { token: "attacker" }]]));
    expect(runtime!.env).toEqual({ T: "shared-secret", V: "shared-secret" });
  });

  it("names missing server secrets", () => {
    const r = new CredentialResolver(new SecretStore(tmp(), {}));
    const cfg = server({ auth: { scope: "server", headers: { K: "${secret:datadog/api_key}" } } });
    expect(r.missing("datadog", cfg, new Map())[0]).toContain("datadog/api_key");
  });
});

describe("canAccess", () => {
  it("allows everyone when no groups are set", () => {
    expect(canAccess(server(), { id: "a", groups: [] })).toBe(true);
    expect(canAccess(server({ groups: [] }), { id: "a", groups: [] })).toBe(true);
  });
  it("requires a matching group otherwise", () => {
    const cfg = server({ groups: ["sre", "data"] });
    expect(canAccess(cfg, { id: "a", groups: ["eng"] })).toBe(false);
    expect(canAccess(cfg, { id: "a", groups: ["eng", "data"] })).toBe(true);
  });
});

describe("TokenStore", () => {
  it("creates tokens that verify, without storing the secret", () => {
    const d = tmp();
    const store = new TokenStore(d);
    const { id, token } = store.create({ user: "alice", groups: ["eng"] });
    expect(token).toMatch(/^lzg_[0-9a-f]{8}_/);
    expect(store.verify(token)).toEqual({ id: "alice", groups: ["eng"], tokenId: id, admin: false });
    const secret = token.split("_").slice(2).join("_");
    expect(readFileSync(store.path, "utf-8")).not.toContain(secret);
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("rejects tampered, malformed, expired and revoked tokens", () => {
    const store = new TokenStore(tmp());
    const { id, token } = store.create({ user: "alice" });
    expect(store.verify(token.slice(0, -2) + "xx")).toBeNull();
    expect(store.verify("not-a-token")).toBeNull();
    expect(store.verify(undefined)).toBeNull();

    const short = store.create({ user: "bob", expiresInMs: -1000 });
    expect(store.verify(short.token)).toBeNull();

    expect(store.revoke(id)).toBe(true);
    expect(store.verify(token)).toBeNull();
    expect(store.revoke(id)).toBe(false);
  });

  it("sees changes made by another process (revoke while the gateway runs)", () => {
    const d = tmp();
    const gateway = new TokenStore(d);
    const { id, token } = gateway.create({ user: "alice" });
    expect(gateway.verify(token)).not.toBeNull();
    new TokenStore(d).revoke(id); // the CLI, in another process
    // mtime granularity can hide a same-millisecond rewrite; force a distinct mtime
    const future = new Date(Date.now() + 5000);
    utimesSync(gateway.path, future, future);
    expect(gateway.verify(token)).toBeNull();
  });

  it("lists tokens without secrets", () => {
    const store = new TokenStore(tmp());
    store.create({ user: "alice", groups: ["a"], label: "ci" });
    const [row] = store.list();
    expect(row).toMatchObject({ user: "alice", groups: ["a"], label: "ci" });
    expect(JSON.stringify(row)).not.toContain("hash");
  });

  it("parses durations and bearer headers", () => {
    expect(parseDuration("90d")).toBe(90 * 86_400_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("Redactor", () => {
  it("replaces secret values, longest first, in text and results", () => {
    const r = new Redactor();
    r.add(["supersecret-token", "supersecret"]);
    expect(r.text("a supersecret-token and supersecret")).toBe("a [redacted] and [redacted]");
    expect(r.result({ content: [{ type: "text", text: "x supersecret-token" }, { type: "image", data: "supersecret" }] })).toEqual({
      content: [{ type: "text", text: "x [redacted]" }, { type: "image", data: "supersecret" }],
    });
  });

  it("ignores very short values rather than shredding text", () => {
    const r = new Redactor();
    r.add(["abc", undefined, ""]);
    expect(r.text("abc abc")).toBe("abc abc");
  });
});

describe("per-user OAuth token paths", () => {
  it("keeps users apart and sanitizes names", () => {
    const base = "/t";
    expect(tokenPath("github", undefined, base)).toBe("/t/github.json");
    expect(tokenPath("github", "alice", base)).toBe("/t/users/alice/github.json");
    expect(tokenPath("github", "../../etc", base)).toBe("/t/users/.._.._etc/github.json");
    expect(tokenPath("../x", "alice", base)).toBe("/t/users/alice/.._x.json");
  });
});

describe("server-scope `${cred:…}` resolution", () => {
  it("reports no gap when the server secret exists, and names it when it doesn't", () => {
    const withSecret = new SecretStore(tmp(), {});
    withSecret.set("shared/token", "v-shared");
    const cfg = server({ auth: { scope: "server", env: { V: "${cred:token}" } } });
    expect(new CredentialResolver(withSecret).missing("shared", cfg, new Map())).toEqual([]);
    expect(new CredentialResolver(new SecretStore(tmp(), {})).missing("shared", cfg, new Map())[0]).toContain("shared/token");
  });
});
