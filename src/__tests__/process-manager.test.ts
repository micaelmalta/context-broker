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

    it("resolves ${VAR} references in env config", async () => {
      process.env.MY_SECRET = "supersecret";
      setupFakeProcess([]);
      const config = makeStdioConfig({ env: { TOKEN: "${MY_SECRET}" } });
      await manager.activate("srv", config);

      const spawnCall = mockSpawnFn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
      expect(spawnCall[2].env["TOKEN"]).toBe("supersecret");

      delete process.env.MY_SECRET;
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

    beforeEach(() => {
      fetchMock = jest.fn<typeof fetch>();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockHttpFlow(
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    ) {
      fetchMock
        // initialize
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({ result: { protocolVersion: "2024-11-05", capabilities: {} } }),
          text: async () => "",
        } as unknown as Response)
        // tools/list
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({ result: { tools } }),
          text: async () => "",
        } as unknown as Response);
    }

    it("activates an HTTP server and returns tools", async () => {
      mockHttpFlow([{ name: "http_tool", description: "An HTTP tool", inputSchema: {} }]);
      const result = await manager.activate("http-srv", makeHttpConfig());

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("http_tool");
      expect(result[0].serverName).toBe("http-srv");
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

      fetchMock.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ result: { content: [{ type: "text", text: "from-http" }] } }),
        text: async () => "",
      } as unknown as Response);

      const result = await manager.callTool("http-srv", "remote_tool", { q: "test" });
      expect(result).toEqual({ content: [{ type: "text", text: "from-http" }] });
    });

    it("retries on 401 with refreshed OAuth token", async () => {
      mockHttpFlow([{ name: "secure_tool", description: "Secure", inputSchema: {} }]);

      // First tool call → 401
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 401,
        text: async () => "",
        json: async () => ({}),
      } as unknown as Response);
      // Retry after token refresh → success
      fetchMock.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ result: { content: [{ type: "text", text: "refreshed" }] } }),
        text: async () => "",
      } as unknown as Response);

      mockGetAccessTokenFn.mockResolvedValue("new-token" as never);

      const oauthConfig = makeHttpConfig("http://localhost:4000/mcp", {
        oauth: { clientId: "client_id", callbackPort: 9999 },
      });
      await manager.activate("oauth-srv", oauthConfig);

      const result = await manager.callTool("oauth-srv", "secure_tool", {});
      expect(mockGetAccessTokenFn).toHaveBeenCalled();
      expect(result).toEqual({ content: [{ type: "text", text: "refreshed" }] });
    });

    it("throws when HTTP initialize returns a non-OK status", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 503,
        text: async () => "Service Unavailable",
        json: async () => ({}),
      } as unknown as Response);

      await expect(manager.activate("http-srv", makeHttpConfig()))
        .rejects.toThrow(/503/);
    });

    it("throws when HTTP tool response contains an error field", async () => {
      mockHttpFlow([{ name: "err_tool", description: "E", inputSchema: {} }]);
      await manager.activate("http-srv", makeHttpConfig());

      fetchMock.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ error: { message: "tool blew up" } }),
        text: async () => "",
      } as unknown as Response);

      await expect(manager.callTool("http-srv", "err_tool", {}))
        .rejects.toThrow("tool blew up");
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
          json: async () => ({ result: { protocolVersion: "2024-11-05", capabilities: {} } }),
          text: async () => "",
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true, status: 200,
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
