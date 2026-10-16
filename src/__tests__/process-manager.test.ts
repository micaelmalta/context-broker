// src/__tests__/process-manager.test.ts
// Unit tests for ProcessManager class

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mocks MUST be declared before any imports that depend on them (ESM hoisting)
// ---------------------------------------------------------------------------

const mockSpawnFn = jest.fn();
const mockGetAccessTokenFn = jest.fn();

jest.unstable_mockModule("child_process", () => ({
  spawn: mockSpawnFn,
}));

jest.unstable_mockModule("../oauth.js", () => ({
  getAccessToken: mockGetAccessTokenFn,
}));

// Dynamic imports AFTER mock setup so they receive the mocked modules
const { ProcessManager } = await import("../process-manager.js");

import type { MCPTool } from "../process-manager.js";
import type { ServerConfig } from "../router.js";

// ---------------------------------------------------------------------------
// FakeChildProcess — a controllable stand-in for a real spawned process
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  stdin: EventEmitter & { write: ReturnType<typeof jest.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed = false;

  constructor() {
    super();
    const stdinEmitter = new EventEmitter() as EventEmitter & { write: ReturnType<typeof jest.fn> };
    stdinEmitter.write = jest.fn();
    this.stdin = stdinEmitter;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.killed = true;
    this.emit("exit", 0);
  }

  respond(id: number, result: unknown) {
    this.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  respondError(id: number, message: string) {
    this.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id, error: { message } }) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function makeStdioConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    description: "A test server",
    keywords: ["test"],
    command: "node",
    args: ["server.js"],
    env: {},
    autoActivate: false,
    ...overrides,
  };
}

function makeHttpConfig(url = "http://localhost:4000/mcp", overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    description: "A test HTTP server",
    keywords: ["test"],
    type: "http",
    url,
    autoActivate: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// setupFakeProcess — returns a FakeChildProcess pre-wired to auto-respond
// to the MCP handshake and tool calls
// ---------------------------------------------------------------------------

function setupFakeProcess(tools: MCPTool[] = []): FakeChildProcess {
  const fake = new FakeChildProcess();

  mockSpawnFn.mockReturnValueOnce(fake);

  fake.stdin.write.mockImplementation((msg: unknown) => {
    const str = typeof msg === "string" ? msg.trim() : String(msg).trim();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(str); } catch { return; }
    if (!parsed || !parsed.id) return; // notification, no response needed

    setImmediate(() => {
      if (parsed.method === "initialize") {
        fake.respond(parsed.id as number, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "fake", version: "0.0.1" },
          capabilities: {},
        });
      } else if (parsed.method === "tools/list") {
        fake.respond(parsed.id as number, {
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      } else if (parsed.method === "tools/call") {
        fake.respond(parsed.id as number, { content: [{ type: "text", text: "ok" }] });
      }
    });
  });

  return fake;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProcessManager", () => {
  let manager: InstanceType<typeof ProcessManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ProcessManager();
  });

  // -------------------------------------------------------------------------
  // Server activation — stdio
  // -------------------------------------------------------------------------
  describe("activate() — stdio", () => {
    it("spawns a child process with correct command and args", async () => {
      setupFakeProcess([]);
      const config = makeStdioConfig({ command: "my-server", args: ["--flag"] });
      await manager.activate("srv", config);

      expect(mockSpawnFn).toHaveBeenCalledWith(
        "my-server",
        ["--flag"],
        expect.objectContaining({ env: expect.any(Object) })
      );
    });

    it("returns the tool list returned by the child", async () => {
      const tools: MCPTool[] = [
        { name: "alpha", description: "Alpha tool", inputSchema: { type: "object" }, serverName: "srv" },
        { name: "beta", description: "Beta tool", inputSchema: {}, serverName: "srv" },
      ];
      setupFakeProcess(tools);
      const result = await manager.activate("srv", makeStdioConfig());

      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toEqual(["alpha", "beta"]);
    });

    it("attaches serverName to every returned tool", async () => {
      const rawTools: MCPTool[] = [
        { name: "foo", description: "Foo", inputSchema: {}, serverName: "IGNORED" },
      ];
      setupFakeProcess(rawTools);
      const result = await manager.activate("my-server", makeStdioConfig());

      expect(result[0].serverName).toBe("my-server");
    });

    it("is a no-op when the server is already active (returns cached tools)", async () => {
      const tools: MCPTool[] = [
        { name: "cached_tool", description: "A tool", inputSchema: {}, serverName: "srv" },
      ];
      setupFakeProcess(tools);
      await manager.activate("srv", makeStdioConfig());

      // Second activation — spawn should NOT be called again
      const result = await manager.activate("srv", makeStdioConfig());
      expect(mockSpawnFn).toHaveBeenCalledTimes(1);
      expect(result[0].name).toBe("cached_tool");
    });

    it("respawns when command or args change (spawn signature differs)", async () => {
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig({ args: ["first.js"] }));
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig({ args: ["second.js"] }));
      expect(mockSpawnFn).toHaveBeenCalledTimes(2);
    });

    it("resolves ${VAR} references in env config", async () => {
      process.env.MY_SECRET = "supersecret";
      setupFakeProcess([]);
      const config = makeStdioConfig({ env: { TOKEN: "${MY_SECRET}" } });
      await manager.activate("srv", config);

      const spawnCall = mockSpawnFn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
      expect(spawnCall[2].env["TOKEN"]).toBe("supersecret");

      delete process.env.MY_SECRET;
    });

    it("passes the full environment by default", async () => {
      process.env.CB_TEST_SECRET = "s3cret";
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());
      const env = (mockSpawnFn.mock.calls[0] as [string, string[], { env: Record<string, string> }])[2].env;
      expect(env.CB_TEST_SECRET).toBe("s3cret");
      delete process.env.CB_TEST_SECRET;
    });

    it("scopes the environment with inheritEnv", async () => {
      process.env.CB_TEST_SECRET = "s3cret";
      process.env.CB_ALLOWED = "ok";
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig({ inheritEnv: ["CB_ALLOWED"], env: { OWN: "1" } }));
      const env = (mockSpawnFn.mock.calls[0] as [string, string[], { env: Record<string, string> }])[2].env;
      expect(env.CB_TEST_SECRET).toBeUndefined();
      expect(env.CB_ALLOWED).toBe("ok");
      expect(env.OWN).toBe("1");
      expect(env.PATH).toBe(process.env.PATH);
      delete process.env.CB_TEST_SECRET;
      delete process.env.CB_ALLOWED;
    });

    it("respawns when inheritEnv changes", async () => {
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig({ inheritEnv: false }));
      expect(mockSpawnFn).toHaveBeenCalledTimes(2);
    });

    it("merges gateway credentials into the env without re-expanding them", async () => {
      process.env.CB_GATEWAY_ONLY = "gateway-private";
      setupFakeProcess([]);
      await manager.activate(
        "srv",
        makeStdioConfig({ env: { OWN: "1" }, inheritEnv: false }),
        { env: { TOKEN: "${CB_GATEWAY_ONLY}", OWN: "overridden" } }
      );
      const env = (mockSpawnFn.mock.calls[0] as [string, string[], { env: Record<string, string> }])[2].env;
      expect(env.TOKEN).toBe("${CB_GATEWAY_ONLY}"); // literal — not expanded from the gateway's environment
      expect(env.OWN).toBe("overridden");
      delete process.env.CB_GATEWAY_ONLY;
    });

    it("respawns when a gateway credential changes, but not when it is unchanged", async () => {
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig(), { env: { TOKEN: "one" } });
      await manager.activate("srv", makeStdioConfig(), { env: { TOKEN: "one" } });
      expect(mockSpawnFn).toHaveBeenCalledTimes(1);

      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig(), { env: { TOKEN: "two" } });
      expect(mockSpawnFn).toHaveBeenCalledTimes(2);
    });

    it("reports each server's tools through onServerTools", async () => {
      const seen: Array<[string, string[]]> = [];
      const mgr = new ProcessManager({ onServerTools: (n, t) => seen.push([n, t.map((x) => x.name)]) });
      setupFakeProcess([{ name: "alpha", description: "A", inputSchema: {}, serverName: "srv" }]);
      await mgr.activate("srv", makeStdioConfig());
      expect(seen).toEqual([["srv", ["alpha"]]]);
    });

    it("sends notifications/initialized after the handshake", async () => {
      const fake = setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());

      const writeCalls = (fake.stdin.write.mock.calls as unknown[][]).map(c => c[0] as string);
      const hasNotif = writeCalls.some(msg => {
        try {
          const parsed = JSON.parse(msg.trim());
          return parsed.method === "notifications/initialized";
        } catch { return false; }
      });
      expect(hasNotif).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool list caching
  // -------------------------------------------------------------------------
  describe("Tool list caching", () => {
    it("listActive() includes the server after activation", async () => {
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());
      expect(manager.listActive()).toContain("srv");
    });

    it("getAllActiveTools() returns tools from all active servers", async () => {
      const tools1: MCPTool[] = [
        { name: "tool_a", description: "A", inputSchema: {}, serverName: "srv1" },
      ];
      const tools2: MCPTool[] = [
        { name: "tool_b", description: "B", inputSchema: {}, serverName: "srv2" },
      ];
      setupFakeProcess(tools1);
      setupFakeProcess(tools2);

      await manager.activate("srv1", makeStdioConfig());
      await manager.activate("srv2", makeStdioConfig());

      const allTools = manager.getAllActiveTools();
      expect(allTools.map(t => t.name)).toEqual(expect.arrayContaining(["tool_a", "tool_b"]));
    });

    it("findServerForTool() returns the correct server name", async () => {
      const tools: MCPTool[] = [
        { name: "my_tool", description: "X", inputSchema: {}, serverName: "srv" },
      ];
      setupFakeProcess(tools);
      await manager.activate("srv", makeStdioConfig());

      expect(manager.findServerForTool("my_tool")).toBe("srv");
    });

    it("findServerForTool() returns undefined for unknown tools", async () => {
      setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());
      expect(manager.findServerForTool("nonexistent_tool")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // callTool — proxying
  // -------------------------------------------------------------------------
  describe("callTool()", () => {
    it("proxies tool calls to the active child process", async () => {
      const tools: MCPTool[] = [
        { name: "my_tool", description: "X", inputSchema: {}, serverName: "srv" },
      ];
      const fake = setupFakeProcess(tools);
      await manager.activate("srv", makeStdioConfig());

      const result = await manager.callTool("srv", "my_tool", { input: "hello" });
      expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });

      const writeCalls = (fake.stdin.write.mock.calls as unknown[][]).map(c => c[0] as string);
      const toolCallMsg = writeCalls
        .map(s => { try { return JSON.parse(s.trim()); } catch { return null; } })
        .find((m): m is Record<string, unknown> => !!m && m.method === "tools/call");

      expect(toolCallMsg).toBeDefined();
      expect((toolCallMsg!.params as Record<string, unknown>).name).toBe("my_tool");
      expect((toolCallMsg!.params as Record<string, unknown>).arguments).toEqual({ input: "hello" });
    });

    it("throws when the server is not active", async () => {
      await expect(manager.callTool("nonexistent", "some_tool", {}))
        .rejects.toThrow("Server nonexistent is not active");
    });

    it("rejects when the child returns an error response", async () => {
      const fake = new FakeChildProcess();
      mockSpawnFn.mockReturnValueOnce(fake);

      fake.stdin.write.mockImplementation((msg: unknown) => {
        const str = typeof msg === "string" ? msg.trim() : String(msg).trim();
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(str); } catch { return; }
        if (!parsed?.id) return;
        setImmediate(() => {
          if (parsed.method === "initialize") {
            fake.respond(parsed.id as number, { protocolVersion: "2024-11-05", capabilities: {} });
          } else if (parsed.method === "tools/list") {
            fake.respond(parsed.id as number, {
              tools: [{ name: "bad_tool", description: "X", inputSchema: {} }],
            });
          } else if (parsed.method === "tools/call") {
            fake.respondError(parsed.id as number, "internal server error");
          }
        });
      });

      await manager.activate("srv", makeStdioConfig());
      await expect(manager.callTool("srv", "bad_tool", {}))
        .rejects.toThrow("internal server error");
    });
  });

  // -------------------------------------------------------------------------
  // Deactivation / lifecycle cleanup
  // -------------------------------------------------------------------------
  describe("deactivate()", () => {
    it("kills the child process and removes it from the active map", async () => {
      const fake = setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());

      manager.deactivate("srv");

      expect(fake.killed).toBe(true);
      expect(manager.listActive()).not.toContain("srv");
    });

    it("rejects in-flight requests with a deactivation error", async () => {
      const fake = new FakeChildProcess();
      mockSpawnFn.mockReturnValueOnce(fake);

      fake.stdin.write.mockImplementation((msg: unknown) => {
        const str = typeof msg === "string" ? msg.trim() : String(msg).trim();
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(str); } catch { return; }
        if (!parsed?.id) return;
        if (parsed.method === "initialize") {
          setImmediate(() => fake.respond(parsed.id as number, { protocolVersion: "2024-11-05", capabilities: {} }));
        } else if (parsed.method === "tools/list") {
          setImmediate(() => fake.respond(parsed.id as number, {
            tools: [{ name: "slow_tool", description: "X", inputSchema: {} }],
          }));
        }
        // tools/call intentionally unanswered
      });

      await manager.activate("srv", makeStdioConfig());
      const callPromise = manager.callTool("srv", "slow_tool", {});
      manager.deactivate("srv");

      await expect(callPromise).rejects.toThrow(/deactivated/i);
    });

    it("is a no-op for unknown server names (does not throw)", () => {
      expect(() => manager.deactivate("nonexistent")).not.toThrow();
    });

    it("removes the server's tools from getAllActiveTools() after deactivation", async () => {
      const tools: MCPTool[] = [
        { name: "gone_tool", description: "X", inputSchema: {}, serverName: "srv" },
      ];
      setupFakeProcess(tools);
      await manager.activate("srv", makeStdioConfig());
      expect(manager.getAllActiveTools().map(t => t.name)).toContain("gone_tool");

      manager.deactivate("srv");
      expect(manager.getAllActiveTools().map(t => t.name)).not.toContain("gone_tool");
    });
  });

  // -------------------------------------------------------------------------
  // Unexpected process exit
  // -------------------------------------------------------------------------
  describe("unexpected process exit", () => {
    it("removes the server from the active map when the child exits", async () => {
      const fake = setupFakeProcess([]);
      await manager.activate("srv", makeStdioConfig());
      expect(manager.listActive()).toContain("srv");

      fake.emit("exit", 1);

      expect(manager.listActive()).not.toContain("srv");
    });

    it("rejects in-flight requests when the child exits unexpectedly", async () => {
      const fake = new FakeChildProcess();
      mockSpawnFn.mockReturnValueOnce(fake);

      fake.stdin.write.mockImplementation((msg: unknown) => {
        const str = typeof msg === "string" ? msg.trim() : String(msg).trim();
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(str); } catch { return; }
        if (!parsed?.id) return;
        if (parsed.method === "initialize") {
          setImmediate(() => fake.respond(parsed.id as number, { protocolVersion: "2024-11-05", capabilities: {} }));
        } else if (parsed.method === "tools/list") {
          setImmediate(() => fake.respond(parsed.id as number, {
            tools: [{ name: "crash_tool", description: "X", inputSchema: {} }],
          }));
        }
        // tools/call: process crashes instead of responding
      });

      await manager.activate("srv", makeStdioConfig());
      const callPromise = manager.callTool("srv", "crash_tool", {});

      fake.emit("exit", 1);

      await expect(callPromise).rejects.toThrow(/exited with code 1/);
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------
  describe("error cases", () => {
    it("rejects when handshake times out", async () => {
      jest.useFakeTimers();

      const fake = new FakeChildProcess();
      mockSpawnFn.mockReturnValueOnce(fake);
      // Never respond → timeout
      fake.stdin.write.mockImplementation(() => {});

      const activatePromise = manager.activate("srv", makeStdioConfig());

      // Advance past the 600 000ms handshake timeout
      jest.advanceTimersByTime(700_000);

      await expect(activatePromise).rejects.toThrow(/timed out/i);

      jest.useRealTimers();
    }, 15_000);
  });

  // -------------------------------------------------------------------------
  // HTTP server activation
  // -------------------------------------------------------------------------
  describe("activate() — HTTP", () => {
    let fetchMock: ReturnType<typeof jest.fn>;

    const realFetch = global.fetch;

    beforeEach(() => {
      fetchMock = jest.fn<typeof fetch>();
      global.fetch = fetchMock as unknown as typeof fetch;
      mockGetAccessTokenFn.mockResolvedValue("test-token" as never);
    });

    afterEach(() => {
      global.fetch = realFetch;
      jest.restoreAllMocks();
    });

    function jsonResponse(body: unknown, status = 200) {
      const text = JSON.stringify(body);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => text,
      } as unknown as Response;
    }

    function mockHttpFlow(
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    ) {
      fetchMock
        // initialize
        .mockResolvedValueOnce(jsonResponse({ result: { protocolVersion: "2024-11-05", capabilities: {} } }))
        // notifications/initialized (best-effort POST)
        .mockResolvedValueOnce(jsonResponse({}))
        // tools/list
        .mockResolvedValueOnce(jsonResponse({ result: { tools } }));
    }

    it("activates an HTTP server and returns tools", async () => {
      mockHttpFlow([{ name: "http_tool", description: "An HTTP tool", inputSchema: {} }]);
      const result = await manager.activate("http-srv", makeHttpConfig());

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("http_tool");
      expect(result[0].serverName).toBe("http-srv");
      const initCall = fetchMock.mock.calls[0];
      const initHeaders = (initCall?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
      expect(initHeaders.Accept).toBe("application/json, text/event-stream");
    });

    it("starts OAuth when initialize answers 401 and retries with the token", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      mockHttpFlow([{ name: "secure_tool", description: "Secure", inputSchema: {} }]);

      const result = await manager.activate("hq", makeHttpConfig("https://mcp.example.com/mcp"));

      expect(result.map((t) => t.name)).toEqual(["secure_tool"]);
      expect(mockGetAccessTokenFn).toHaveBeenCalledWith(
        "hq",
        "https://mcp.example.com/mcp",
        {},
        { force: true }
      );
      const retryHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
      expect(retryHeaders.Authorization).toBe("Bearer test-token");
    });

    it("sends gateway credentials as headers and reopens the session when they change", async () => {
      mockHttpFlow([{ name: "t", description: "T", inputSchema: {} }]);
      await manager.activate("h", makeHttpConfig(), { headers: { "X-Api-Key": "key-one" } });
      const first = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
      expect(first["X-Api-Key"]).toBe("key-one");

      // same credential → no new handshake
      const calls = fetchMock.mock.calls.length;
      await manager.activate("h", makeHttpConfig(), { headers: { "X-Api-Key": "key-one" } });
      expect(fetchMock.mock.calls.length).toBe(calls);

      // changed credential → fresh session
      mockHttpFlow([{ name: "t", description: "T", inputSchema: {} }]);
      await manager.activate("h", makeHttpConfig(), { headers: { "X-Api-Key": "key-two" } });
      const reopened = fetchMock.mock.calls.slice(calls).map((c) => (c[1] as RequestInit).headers as Record<string, string>);
      expect(reopened.some((h) => h["X-Api-Key"] === "key-two")).toBe(true);
    });

    it("stores OAuth tokens per user only for user-scope servers", async () => {
      const gw = new ProcessManager({ owner: "alice" });
      // user scope: first request 401 → OAuth with owner
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      mockHttpFlow([{ name: "a", description: "A", inputSchema: {} }]);
      await gw.activate("per-user", makeHttpConfig("https://mcp.example.com/mcp", { auth: { scope: "user" } }));
      expect(mockGetAccessTokenFn).toHaveBeenLastCalledWith(
        "per-user", "https://mcp.example.com/mcp", {}, { force: true, owner: "alice" }
      );

      // server scope (default): shared token, no owner
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      mockHttpFlow([{ name: "b", description: "B", inputSchema: {} }]);
      await gw.activate("shared", makeHttpConfig("https://mcp2.example.com/mcp"));
      expect(mockGetAccessTokenFn).toHaveBeenLastCalledWith(
        "shared", "https://mcp2.example.com/mcp", {}, { force: true, owner: undefined }
      );
    });

    it("does not start OAuth when the server is open", async () => {
      mockHttpFlow([{ name: "open_tool", description: "Open", inputSchema: {} }]);
      await manager.activate("open", makeHttpConfig());
      expect(mockGetAccessTokenFn).not.toHaveBeenCalled();
    });

    it("never starts OAuth when oauth is false", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      await expect(
        manager.activate("no-oauth", makeHttpConfig("http://localhost:4000/mcp", { oauth: false }))
      ).rejects.toThrow(/401/);
      expect(mockGetAccessTokenFn).not.toHaveBeenCalled();
    });

    it("sends MCP-Protocol-Version negotiated at initialize on later requests", async () => {
      mockHttpFlow([{ name: "t", description: "T", inputSchema: {} }]);
      await manager.activate("http-srv", makeHttpConfig());
      const listHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
      expect(listHeaders["MCP-Protocol-Version"]).toBe("2024-11-05");
    });

    it("parses SSE initialize/tools/list responses", async () => {
      const sse = (payload: unknown) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          json: async () => payload,
          text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        }) as unknown as Response;

      fetchMock
        .mockResolvedValueOnce(sse({ result: { protocolVersion: "2024-11-05", capabilities: {} } }))
        .mockResolvedValueOnce(sse({}))
        .mockResolvedValueOnce(
          sse({ result: { tools: [{ name: "sse_tool", description: "S", inputSchema: {} }] } })
        );

      const result = await manager.activate("sse-srv", makeHttpConfig());
      expect(result.map((t) => t.name)).toEqual(["sse_tool"]);
    });

    it("includes the HTTP server in listActive()", async () => {
      mockHttpFlow([]);
      await manager.activate("http-srv", makeHttpConfig());
      expect(manager.listActive()).toContain("http-srv");
    });

    it("deactivates an HTTP server cleanly", async () => {
      mockHttpFlow([]);
      await manager.activate("http-srv", makeHttpConfig());
      manager.deactivate("http-srv");
      expect(manager.listActive()).not.toContain("http-srv");
    });

    it("proxies callTool to HTTP server", async () => {
      mockHttpFlow([{ name: "remote_tool", description: "Remote", inputSchema: {} }]);
      await manager.activate("http-srv", makeHttpConfig());

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ result: { content: [{ type: "text", text: "from-http" }] } })
      );

      const result = await manager.callTool("http-srv", "remote_tool", { q: "test" });
      expect(result).toEqual({ content: [{ type: "text", text: "from-http" }] });
    });

    it("retries on 401 with refreshed OAuth token", async () => {
      mockHttpFlow([{ name: "secure_tool", description: "Secure", inputSchema: {} }]);

      // First tool call → 401
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      // Retry after token refresh → success
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ result: { content: [{ type: "text", text: "refreshed" }] } })
      );

      mockGetAccessTokenFn.mockResolvedValue("new-token" as never);

      const oauthConfig = makeHttpConfig("http://localhost:4000/mcp", {
        oauth: { clientId: "client_id", callbackPort: 9999 },
      });
      await manager.activate("oauth-srv", oauthConfig);

      const result = await manager.callTool("oauth-srv", "secure_tool", {});
      expect(mockGetAccessTokenFn).toHaveBeenLastCalledWith(
        "oauth-srv",
        "http://localhost:4000/mcp",
        { clientId: "client_id", callbackPort: 9999 },
        { force: true } // must not replay the rejected cached token
      );
      expect(result).toEqual({ content: [{ type: "text", text: "refreshed" }] });
    });

    it("does not replace a static Authorization header on 401", async () => {
      mockHttpFlow([{ name: "static_tool", description: "S", inputSchema: {} }]);
      await manager.activate(
        "static-srv",
        makeHttpConfig("http://localhost:4000/mcp", { headers: { Authorization: "Bearer static" } })
      );

      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      await expect(manager.callTool("static-srv", "static_tool", {})).rejects.toThrow(/401/);
      expect(mockGetAccessTokenFn).not.toHaveBeenCalled();
    });

    it("re-initializes once when the session has expired (404)", async () => {
      const withSession = (body: unknown) => {
        const r = jsonResponse(body);
        (r as unknown as { headers: Headers }).headers = new Headers({
          "content-type": "application/json",
          "mcp-session-id": "s1",
        });
        return r;
      };
      fetchMock
        .mockResolvedValueOnce(withSession({ result: { protocolVersion: "2025-06-18" } }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ result: { tools: [{ name: "t", description: "T", inputSchema: {} }] } }));
      await manager.activate("sess", makeHttpConfig());

      fetchMock.mockResolvedValueOnce(jsonResponse({}, 404)); // expired
      fetchMock
        .mockResolvedValueOnce(withSession({ result: { protocolVersion: "2025-06-18" } }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ result: { tools: [{ name: "t", description: "T", inputSchema: {} }] } }));
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: { content: [{ type: "text", text: "again" }] } }));

      const result = await manager.callTool("sess", "t", {});
      expect(result).toEqual({ content: [{ type: "text", text: "again" }] });
    });

    it("picks the SSE message whose id matches the request", async () => {
      const sseBody = (...payloads: unknown[]) =>
        payloads.map((p) => `event: message\ndata: ${JSON.stringify(p)}\n\n`).join("");
      const sseRes = (text: string) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          text: async () => text,
        }) as unknown as Response;

      mockHttpFlow([{ name: "t", description: "T", inputSchema: {} }]);
      await manager.activate("sse", makeHttpConfig());

      fetchMock.mockResolvedValueOnce(
        sseRes(
          sseBody(
            { jsonrpc: "2.0", method: "notifications/message", params: {} },
            { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "match" }] } },
            { jsonrpc: "2.0", id: 99, result: { content: [{ type: "text", text: "other" }] } }
          )
        )
      );
      const result = await manager.callTool("sse", "t", {});
      expect(result).toEqual({ content: [{ type: "text", text: "match" }] });
    });

    it("surfaces JSON-RPC error code and data", async () => {
      mockHttpFlow([{ name: "t", description: "T", inputSchema: {} }]);
      await manager.activate("rpc", makeHttpConfig());
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: -32602, message: "bad params", data: { x: 1 } } }));
      await expect(manager.callTool("rpc", "t", {})).rejects.toMatchObject({
        name: "McpRpcError",
        code: -32602,
        data: { x: 1 },
      });
    });

    it("passes an abort signal so hung servers time out", async () => {
      mockHttpFlow([{ name: "t", description: "T", inputSchema: {} }]);
      await manager.activate("sig", makeHttpConfig());
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: { content: [] } }));
      await manager.callTool("sig", "t", {});
      const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("throws when HTTP initialize returns a non-OK status", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => "Service Unavailable",
        json: async () => ({}),
      } as unknown as Response);

      await expect(manager.activate("http-srv", makeHttpConfig()))
        .rejects.toThrow(/503/);
    });

    it("throws when HTTP tool response contains an error field", async () => {
      mockHttpFlow([{ name: "err_tool", description: "E", inputSchema: {} }]);
      await manager.activate("http-srv", makeHttpConfig());

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "tool blew up" } }));

      await expect(manager.callTool("http-srv", "err_tool", {}))
        .rejects.toThrow("tool blew up");
    });
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------
  describe("robustness", () => {
    function silentFake(onWrite: (parsed: Record<string, unknown>, fake: FakeChildProcess) => void) {
      const fake = new FakeChildProcess();
      mockSpawnFn.mockReturnValueOnce(fake);
      fake.stdin.write.mockImplementation((msg: unknown) => {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(String(msg).trim()); } catch { return; }
        onWrite(parsed, fake);
      });
      return fake;
    }

    const answerHandshake = (parsed: Record<string, unknown>, fake: FakeChildProcess, tools: unknown[] = []) => {
      if (!parsed.id) return;
      if (parsed.method === "initialize") {
        setImmediate(() => fake.respond(parsed.id as number, { protocolVersion: "2024-11-05", capabilities: {} }));
      } else if (parsed.method === "tools/list") {
        setImmediate(() => fake.respond(parsed.id as number, { tools }));
      }
    };

    it("rejects (does not crash) when the command cannot be spawned", async () => {
      const fake = silentFake(() => {
        setImmediate(() => fake.emit("error", new Error("spawn nope ENOENT")));
      });
      await expect(manager.activate("bad", makeStdioConfig({ command: "nope" })))
        .rejects.toThrow(/failed to run "nope".*ENOENT/);
      expect(fake.killed).toBe(true);
      expect(manager.listActive()).not.toContain("bad");
    });

    it("tolerates stdin 'error' events (EPIPE) without throwing", async () => {
      const fake = silentFake((parsed, f) => answerHandshake(parsed, f));
      await manager.activate("srv", makeStdioConfig());
      expect(() => fake.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
    });

    it("kills the child when the handshake fails", async () => {
      const fake = silentFake((parsed, f) => {
        if (parsed.method === "initialize") {
          setImmediate(() => f.respondError(parsed.id as number, "nope"));
        }
      });
      await expect(manager.activate("srv", makeStdioConfig())).rejects.toThrow("nope");
      expect(fake.killed).toBe(true);
      expect(manager.listActive()).not.toContain("srv");
    });

    it("shares one spawn between concurrent activations of the same server", async () => {
      setupFakeProcess([{ name: "t", description: "T", inputSchema: {}, serverName: "srv" }]);
      const [a, b] = await Promise.all([
        manager.activate("srv", makeStdioConfig()),
        manager.activate("srv", makeStdioConfig()),
      ]);
      expect(mockSpawnFn).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });

    it("honours a per-server toolTimeoutMs", async () => {
      silentFake((parsed, f) => answerHandshake(parsed, f, [{ name: "slow", description: "S", inputSchema: {} }]));
      await manager.activate("srv", makeStdioConfig({ toolTimeoutMs: 30 }));
      await expect(manager.callTool("srv", "slow", {})).rejects.toThrow(/timed out after 30ms/);
    });

    it("allows tool calls longer than the old 10s default", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
      try {
        const fake = silentFake((parsed, f) => {
          answerHandshake(parsed, f, [{ name: "slow", description: "S", inputSchema: {} }]);
        });
        await manager.activate("srv", makeStdioConfig());
        const call = manager.callTool("srv", "slow", {});
        jest.advanceTimersByTime(60_000);
        const sent = (fake.stdin.write.mock.calls as unknown[][])
          .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
          .find((m) => m?.method === "tools/call");
        fake.respond(sent.id, { content: [{ type: "text", text: "done" }] });
        await expect(call).resolves.toEqual({ content: [{ type: "text", text: "done" }] });
      } finally {
        jest.useRealTimers();
      }
    });

    it("answers server pings and does not mistake server requests for responses", async () => {
      const fake = silentFake((parsed, f) => {
        answerHandshake(parsed, f, [{ name: "t", description: "T", inputSchema: {} }]);
        if (parsed.method === "tools/call") {
          // Server asks us something using the SAME id, then answers for real.
          setImmediate(() => {
            f.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: parsed.id, method: "ping" }) + "\n");
            f.respond(parsed.id as number, { content: [{ type: "text", text: "real" }] });
          });
        }
      });
      await manager.activate("srv", makeStdioConfig());
      const result = await manager.callTool("srv", "t", {});
      expect(result).toEqual({ content: [{ type: "text", text: "real" }] });

      const replies = (fake.stdin.write.mock.calls as unknown[][])
        .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
        .filter((m) => m && m.result && Object.keys(m.result).length === 0);
      expect(replies.length).toBeGreaterThan(0);
    });

    it("refreshes tools and notifies when the server sends tools/list_changed", async () => {
      const onToolsChanged = jest.fn();
      const mgr = new ProcessManager({ onToolsChanged });
      let tools: unknown[] = [{ name: "old", description: "O", inputSchema: {} }];
      const fake = silentFake((parsed, f) => answerHandshake(parsed, f, tools));
      void fake;
      await mgr.activate("srv", makeStdioConfig());
      onToolsChanged.mockClear();

      tools = [{ name: "new", description: "N", inputSchema: {} }];
      fake.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      expect(mgr.getAllActiveTools().map((t) => t.name)).toEqual(["new"]);
      expect(onToolsChanged).toHaveBeenCalledTimes(1);
    });

    it("refuses to activate a server whose tools collide with an active one", async () => {
      setupFakeProcess([{ name: "search", description: "A", inputSchema: {}, serverName: "a" }]);
      await manager.activate("a", makeStdioConfig());

      const fake = setupFakeProcess([{ name: "search", description: "B", inputSchema: {}, serverName: "b" }]);
      await expect(manager.activate("b", makeStdioConfig({ args: ["b.js"] })))
        .rejects.toThrow(/collision.*search.*"a"/);
      expect(fake.killed).toBe(true);
      expect(manager.listActive()).toEqual(["a"]);
    });

    it("refuses tools that shadow reserved broker tool names", async () => {
      const mgr = new ProcessManager({ reservedToolNames: ["discover_tools"] });
      const fake = setupFakeProcess([{ name: "discover_tools", description: "X", inputSchema: {}, serverName: "x" }]);
      await expect(mgr.activate("x", makeStdioConfig())).rejects.toThrow(/reserved broker tool/);
      expect(fake.killed).toBe(true);
    });

    it("notifies on activate, deactivate and unexpected exit", async () => {
      const onToolsChanged = jest.fn();
      const mgr = new ProcessManager({ onToolsChanged });

      setupFakeProcess([]);
      await mgr.activate("one", makeStdioConfig());
      expect(onToolsChanged).toHaveBeenCalledTimes(1);

      expect(mgr.deactivate("one")).toBe(true);
      expect(onToolsChanged).toHaveBeenCalledTimes(2);

      const fake = setupFakeProcess([]);
      await mgr.activate("two", makeStdioConfig());
      fake.emit("exit", 1);
      expect(onToolsChanged).toHaveBeenCalledTimes(4); // activate + exit

      expect(mgr.deactivate("nonexistent")).toBe(false);
      expect(onToolsChanged).toHaveBeenCalledTimes(4);
    });

    it("preserves JSON-RPC error code and data from stdio servers", async () => {
      silentFake((parsed, f) => {
        answerHandshake(parsed, f, [{ name: "t", description: "T", inputSchema: {} }]);
        if (parsed.method === "tools/call") {
          setImmediate(() =>
            f.stdout.emit(
              "data",
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: "boom", data: { a: 1 } } }) + "\n"
            )
          );
        }
      });
      await manager.activate("srv", makeStdioConfig());
      await expect(manager.callTool("srv", "t", {})).rejects.toMatchObject({ code: -32000, data: { a: 1 } });
    });
  });

  // -------------------------------------------------------------------------
  // Mixed stdio + HTTP
  // -------------------------------------------------------------------------
  describe("mixed stdio + HTTP servers", () => {
    it("listActive returns both stdio and HTTP servers", async () => {
      setupFakeProcess([]);
      await manager.activate("stdio-srv", makeStdioConfig());

      const fetchMock = jest.fn<typeof fetch>();
      global.fetch = fetchMock as unknown as typeof fetch;

      fetchMock
        .mockResolvedValueOnce({
          ok: true, status: 200,
          headers: new Headers(),
          json: async () => ({ result: { protocolVersion: "2024-11-05", capabilities: {} } }),
          text: async () => "",
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true, status: 200,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true, status: 200,
          headers: new Headers(),
          json: async () => ({ result: { tools: [] } }),
          text: async () => "",
        } as unknown as Response);

      await manager.activate("http-srv", makeHttpConfig());

      const active = manager.listActive();
      expect(active).toContain("stdio-srv");
      expect(active).toContain("http-srv");
    });
  });
});
