import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const mockExistsSyncFn = jest.fn();
const mockExecSyncFn = jest.fn();
const mockHomedirFn = jest.fn(() => "/home/testuser");

jest.unstable_mockModule("fs", () => ({
  existsSync: mockExistsSyncFn,
}));
jest.unstable_mockModule("child_process", () => ({
  execSync: mockExecSyncFn,
}));
jest.unstable_mockModule("os", () => ({
  homedir: mockHomedirFn,
}));

const { detectShellSecretFile, resolveBrokerEntry } = await import("../migrate-helpers.js");

describe("detectShellSecretFile", () => {
  const originalShell = process.env.SHELL;

  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  it("returns fish config for fish shell", () => {
    process.env.SHELL = "/opt/homebrew/bin/fish";
    const result = detectShellSecretFile();
    expect(result.path).toBe("/home/testuser/.config/fish/config.fish");
    expect(result.label).toBe("~/.config/fish/config.fish");
    expect(result.format("MY_KEY", "myval")).toBe('set -gx MY_KEY "myval"');
  });

  it("fish checkExisting detects set -gx", () => {
    process.env.SHELL = "/usr/bin/fish";
    const { checkExisting } = detectShellSecretFile();
    expect(checkExisting("set -gx MY_KEY value\n", "MY_KEY")).toBe(true);
    expect(checkExisting("set -Ux MY_KEY value\n", "MY_KEY")).toBe(true);
    expect(checkExisting("# nothing here\n", "MY_KEY")).toBe(false);
  });

  it("returns zshenv for zsh shell", () => {
    process.env.SHELL = "/bin/zsh";
    const result = detectShellSecretFile();
    expect(result.path).toBe("/home/testuser/.zshenv");
    expect(result.label).toBe("~/.zshenv");
    expect(result.format("MY_KEY", "myval")).toBe('export MY_KEY="myval"');
  });

  it("returns zshenv for bash shell", () => {
    process.env.SHELL = "/bin/bash";
    const result = detectShellSecretFile();
    expect(result.path).toBe("/home/testuser/.zshenv");
  });

  it("zsh checkExisting detects export", () => {
    process.env.SHELL = "/bin/zsh";
    const { checkExisting } = detectShellSecretFile();
    expect(checkExisting('export MY_KEY="value"\n', "MY_KEY")).toBe(true);
    expect(checkExisting("# nothing\n", "MY_KEY")).toBe(false);
  });
});

describe("resolveBrokerEntry", () => {
  beforeEach(() => {
    mockExistsSyncFn.mockReset();
    mockExecSyncFn.mockReset();
  });

  it("returns global binary when context-broker is on PATH", () => {
    mockExecSyncFn.mockReturnValue("/usr/local/bin/context-broker\n");
    const result = resolveBrokerEntry("/some/dist");
    expect(result).toEqual({ command: "/usr/local/bin/context-broker", args: [] });
  });

  it("falls back to node + dist path when binary not found", () => {
    mockExecSyncFn.mockImplementation(() => { throw new Error("not found"); });
    mockExistsSyncFn.mockReturnValue(true);
    const result = resolveBrokerEntry("/some/dist");
    expect(result).toEqual({ command: "node", args: ["/some/dist/index.js"] });
  });

  it("falls back to npx when neither binary nor dist exists", () => {
    mockExecSyncFn.mockImplementation(() => { throw new Error("not found"); });
    mockExistsSyncFn.mockReturnValue(false);
    const result = resolveBrokerEntry("/some/dist");
    expect(result).toEqual({ command: "npx", args: ["-y", "context-broker"] });
  });

  it("trims whitespace from which output", () => {
    mockExecSyncFn.mockReturnValue("  /usr/bin/context-broker  \n");
    const result = resolveBrokerEntry("/some/dist");
    expect(result.command).toBe("/usr/bin/context-broker");
  });
});
