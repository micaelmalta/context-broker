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
    expect(checkExisting("set -xg MY_KEY value\n", "MY_KEY")).toBe(true);
    expect(checkExisting("set -xU MY_KEY value\n", "MY_KEY")).toBe(true);
    expect(checkExisting("# nothing here\n", "MY_KEY")).toBe(false);
  });

  it("returns zshenv for zsh shell", () => {
    process.env.SHELL = "/bin/zsh";
    const result = detectShellSecretFile();
    expect(result.path).toBe("/home/testuser/.zshenv");
    expect(result.label).toBe("~/.zshenv");
    expect(result.format("MY_KEY", "myval")).toBe('export MY_KEY="myval"');
  });

  it("returns bashrc for bash shell", () => {
    process.env.SHELL = "/bin/bash";
    const result = detectShellSecretFile();
    expect(result.path).toBe("/home/testuser/.bashrc");
    expect(result.label).toBe("~/.bashrc");
  });

  it("returns zshenv for unknown/empty shell", () => {
    process.env.SHELL = "";
    const result = detectShellSecretFile();
    expect(result.path).toBe("/home/testuser/.zshenv");
    expect(result.label).toBe("~/.zshenv");
  });

  it("zsh checkExisting detects export", () => {
    process.env.SHELL = "/bin/zsh";
    const { checkExisting } = detectShellSecretFile();
    expect(checkExisting('export MY_KEY="value"\n', "MY_KEY")).toBe(true);
    expect(checkExisting("# nothing\n", "MY_KEY")).toBe(false);
  });

  it("checkExisting does not false-positive on prefix match", () => {
    process.env.SHELL = "/bin/zsh";
    const { checkExisting } = detectShellSecretFile();
    expect(checkExisting('export MY_KEY_OLD="value"\n', "MY_KEY")).toBe(false);
  });

  it("fish checkExisting matches at end of file without trailing newline", () => {
    process.env.SHELL = "/usr/bin/fish";
    const { checkExisting } = detectShellSecretFile();
    expect(checkExisting("set -gx MY_KEY value", "MY_KEY")).toBe(true);
  });

  it("fish checkExisting does not false-positive on prefix match", () => {
    process.env.SHELL = "/usr/bin/fish";
    const { checkExisting } = detectShellSecretFile();
    expect(checkExisting("set -gx MY_KEY_OLD value\n", "MY_KEY")).toBe(false);
  });

  it("fish format escapes special chars in value", () => {
    process.env.SHELL = "/usr/bin/fish";
    const { format } = detectShellSecretFile();
    expect(format("K", 'val"with"quotes')).toBe('set -gx K "val\\"with\\"quotes"');
    expect(format("K", "val\\slash")).toBe('set -gx K "val\\\\slash"');
    expect(format("K", "val$VAR")).toBe('set -gx K "val\\$VAR"');
    expect(format("K", "val(cmd)")).toBe('set -gx K "val\\(cmd\\)"');
  });

  it("zsh format escapes special chars in value", () => {
    process.env.SHELL = "/bin/zsh";
    const { format } = detectShellSecretFile();
    expect(format("K", 'val"q')).toBe('export K="val\\"q"');
    expect(format("K", "val$VAR")).toBe('export K="val\\$VAR"');
    expect(format("K", "val\\slash")).toBe('export K="val\\\\slash"');
    expect(format("K", "val`cmd`")).toBe('export K="val\\`cmd\\`"');
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

  it("rejects npx shim returned by which (contains node_modules)", () => {
    mockExecSyncFn.mockReturnValue("/home/user/.npm/_npx/abc/node_modules/.bin/context-broker\n");
    mockExistsSyncFn.mockReturnValue(true);
    const result = resolveBrokerEntry("/some/dist");
    expect(result).toEqual({ command: "node", args: ["/some/dist/index.js"] });
  });

  it("rejects npx shim returned by which (contains _npx)", () => {
    mockExecSyncFn.mockReturnValue("/tmp/.npm/_npx/context-broker\n");
    mockExistsSyncFn.mockReturnValue(false);
    const result = resolveBrokerEntry("/some/dist");
    expect(result).toEqual({ command: "npx", args: ["-y", "context-broker"] });
  });

  it("skips local dist when path is inside node_modules (npx run)", () => {
    mockExecSyncFn.mockImplementation(() => { throw new Error("not found"); });
    mockExistsSyncFn.mockReturnValue(true);
    const result = resolveBrokerEntry("/tmp/.npm/_npx/abc123/node_modules/context-broker/dist");
    expect(result).toEqual({ command: "npx", args: ["-y", "context-broker"] });
  });
});
