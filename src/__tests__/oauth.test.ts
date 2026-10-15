// src/__tests__/oauth.test.ts
// OAuth flow against a local fake authorization server (no real network, no real browser).

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "http";
import { createRequire } from "module";

// Jest's sandboxed process.env does not affect os.homedir(), so mock it explicitly.
// oauth.ts resolves its paths at import time, hence this must precede the import.
const home = mkdtempSync(join(tmpdir(), "cb-oauth-"));
const realOs = createRequire(import.meta.url)("os") as typeof import("os");
jest.unstable_mockModule("os", () => ({
  ...realOs,
  default: { ...realOs, homedir: () => home },
  homedir: () => home,
}));

const mockExecFile = jest.fn();
jest.unstable_mockModule("child_process", () => ({
  execFile: mockExecFile,
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

let asPort = 0;
const mockDiscover = jest.fn();
const mockRegister = jest.fn();
jest.unstable_mockModule("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: mockDiscover,
  registerClient: mockRegister,
}));

const { getAccessToken, openBrowser } = await import("../oauth.js");

// Safety net: never let these tests touch the real config directory.
if (!home.startsWith(tmpdir())) throw new Error("test home not isolated");

const SERVER_URL = "https://mcp.example.com/mcp";
const tokenDir = join(home, ".config", "lazygate", "tokens");
const tokenFile = (n: string) => join(tokenDir, `${n}.json`);

let as: Server;
const tokenRequests: URLSearchParams[] = [];
let tokenResponse: () => Record<string, unknown> = () => ({
  access_token: "fresh-access",
  refresh_token: "fresh-refresh",
  expires_in: 3600,
  token_type: "Bearer",
});

beforeAll(async () => {
  as = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/token") {
        tokenRequests.push(new URLSearchParams(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenResponse()));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => as.listen(0, "127.0.0.1", () => r()));
  asPort = (as.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => as.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  tokenRequests.length = 0;
  rmSync(join(home, ".config"), { recursive: true, force: true });
  tokenResponse = () => ({
    access_token: "fresh-access",
    refresh_token: "fresh-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  mockDiscover.mockImplementation(async () => ({
    authorizationServerUrl: `http://127.0.0.1:${asPort}`,
    authorizationServerMetadata: {
      issuer: `http://127.0.0.1:${asPort}`,
      authorization_endpoint: `http://127.0.0.1:${asPort}/authorize`,
      token_endpoint: `http://127.0.0.1:${asPort}/token`,
      registration_endpoint: `http://127.0.0.1:${asPort}/register`,
      response_types_supported: ["code"],
    },
    resourceMetadata: { resource: SERVER_URL, scopes_supported: ["mcp.read"] },
  }));
  mockRegister.mockImplementation(async () => ({ client_id: "dyn-client" }));
});

function writeToken(name: string, token: Record<string, unknown>) {
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenFile(name), JSON.stringify(token));
}

/** Pretend to be the browser: follow the authorize URL's redirect with the given params. */
function fakeBrowser(
  mutate: (redirect: URL, state: string) => Array<{ url: URL; expectStatus: number }>
) {
  mockExecFile.mockImplementation((_cmd: unknown, args: unknown) => {
    const authUrl = new URL((args as string[]).at(-1)!);
    const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
    redirect.hostname = "127.0.0.1"; // avoid localhost → ::1 ambiguity in CI
    const state = authUrl.searchParams.get("state")!;
    setTimeout(async () => {
      for (const { url, expectStatus } of mutate(redirect, state)) {
        const res = await fetch(url);
        expect(res.status).toBe(expectStatus);
      }
    }, 10);
    return { unref() {} };
  });
}

describe("getAccessToken", () => {
  it("returns a valid cached token without any network discovery", async () => {
    writeToken("srv", { access_token: "cached", expires_at: Date.now() + 3_600_000, resource: SERVER_URL });
    await expect(getAccessToken("srv", SERVER_URL)).resolves.toBe("cached");
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("ignores a token issued for a different server URL", async () => {
    writeToken("srv", {
      access_token: "other-host-token",
      expires_at: Date.now() + 3_600_000,
      resource: "https://elsewhere.example.com/mcp",
    });
    fakeBrowser((redirect, state) => {
      const ok = new URL(redirect);
      ok.search = `?code=abc&state=${state}`;
      return [{ url: ok, expectStatus: 200 }];
    });
    const token = await getAccessToken("srv", SERVER_URL, { clientId: "pre" });
    expect(token).toBe("fresh-access");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("rejects callbacks with a wrong state or path and accepts the right one", async () => {
    fakeBrowser((redirect, state) => {
      const wrongState = new URL(redirect);
      wrongState.search = "?code=evil&state=nope";
      const wrongPath = new URL(redirect);
      wrongPath.pathname = "/elsewhere";
      wrongPath.search = `?code=evil&state=${state}`;
      const ok = new URL(redirect);
      ok.search = `?code=good&state=${state}`;
      return [
        { url: wrongState, expectStatus: 400 },
        { url: wrongPath, expectStatus: 404 },
        { url: ok, expectStatus: 200 },
      ];
    });

    const token = await getAccessToken("srv", SERVER_URL, { clientId: "pre" });
    expect(token).toBe("fresh-access");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get("code")).toBe("good");
    expect(tokenRequests[0].get("resource")).toBe(SERVER_URL);
  });

  it("sends resource, PKCE and requests resource-advertised scopes only", async () => {
    let authUrl!: URL;
    mockExecFile.mockImplementation((_c: unknown, args: unknown) => {
      authUrl = new URL((args as string[]).at(-1)!);
      const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
      redirect.hostname = "127.0.0.1";
      redirect.search = `?code=c&state=${authUrl.searchParams.get("state")}`;
      setTimeout(() => void fetch(redirect), 10);
      return { unref() {} };
    });
    await getAccessToken("srv", SERVER_URL);
    expect(authUrl.searchParams.get("resource")).toBe(SERVER_URL);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toBe("mcp.read");
    expect(authUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("writes token files with mode 0600 in a 0700 directory", async () => {
    fakeBrowser((redirect, state) => {
      const ok = new URL(redirect);
      ok.search = `?code=abc&state=${state}`;
      return [{ url: ok, expectStatus: 200 }];
    });
    await getAccessToken("srv", SERVER_URL, { clientId: "pre" });

    if (process.platform !== "win32") {
      expect(statSync(tokenFile("srv")).mode & 0o777).toBe(0o600);
      expect(statSync(tokenDir).mode & 0o777).toBe(0o700);
    }
    const saved = JSON.parse(readFileSync(tokenFile("srv"), "utf-8"));
    expect(saved.resource).toBe(SERVER_URL);
  });

  it("force=true skips the cached access token and refreshes instead", async () => {
    writeToken("srv", {
      access_token: "revoked",
      refresh_token: "r1",
      client_id: "pre",
      expires_at: Date.now() + 3_600_000,
      resource: SERVER_URL,
    });
    const token = await getAccessToken("srv", SERVER_URL, {}, { force: true });
    expect(token).toBe("fresh-access");
    expect(tokenRequests[0].get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[0].get("refresh_token")).toBe("r1");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("shares one flow between concurrent callers (one browser window)", async () => {
    fakeBrowser((redirect, state) => {
      const ok = new URL(redirect);
      ok.search = `?code=abc&state=${state}`;
      return [{ url: ok, expectStatus: 200 }];
    });
    const [a, b] = await Promise.all([
      getAccessToken("srv", SERVER_URL, { clientId: "pre" }),
      getAccessToken("srv", SERVER_URL, { clientId: "pre" }),
    ]);
    expect(a).toBe(b);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("reuses the remembered dynamic client and callback port", async () => {
    fakeBrowser((redirect, state) => {
      const ok = new URL(redirect);
      ok.search = `?code=abc&state=${state}`;
      return [{ url: ok, expectStatus: 200 }];
    });
    await getAccessToken("srv", SERVER_URL);
    expect(mockRegister).toHaveBeenCalledTimes(1);

    const client = JSON.parse(readFileSync(join(home, ".config", "lazygate", "clients", "srv.json"), "utf-8"));
    expect(client.callback_port).toBeGreaterThan(0);
    expect(client.resource).toBe(SERVER_URL);

    // Expire the token (no refresh token) → second authorization reuses the client.
    writeToken("srv", { access_token: "old", expires_at: Date.now() - 1000, resource: SERVER_URL });
    await getAccessToken("srv", SERVER_URL);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("sanitises server names used as file names", async () => {
    fakeBrowser((redirect, state) => {
      const ok = new URL(redirect);
      ok.search = `?code=abc&state=${state}`;
      return [{ url: ok, expectStatus: 200 }];
    });
    await getAccessToken("../../escape", SERVER_URL, { clientId: "pre" });
    expect(existsSync(join(home, ".config", "lazygate", "tokens", ".._.._escape.json"))).toBe(true);
    expect(existsSync(join(home, "escape.json"))).toBe(false);
  });
});

describe("openBrowser", () => {
  it("never goes through a shell, so metacharacters in the URL are inert", () => {
    mockExecFile.mockReturnValue({ unref() {} });
    openBrowser("https://evil.example/authorize$(touch${IFS}pwned)`id`|sh");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(["open", "xdg-open", "rundll32"]).toContain(cmd);
    expect(Array.isArray(args)).toBe(true);
    expect(opts.shell).toBeUndefined();
  });

  it("refuses non-http(s) URLs", () => {
    openBrowser("file:///etc/passwd");
    openBrowser("javascript:alert(1)");
    openBrowser("not a url");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
