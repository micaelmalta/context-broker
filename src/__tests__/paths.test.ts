// src/__tests__/paths.test.ts

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { adoptLegacyConfigDir, configDir, APP_NAME } from "../paths.js";

let home: string;
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function setup(): string {
  home = mkdtempSync(join(tmpdir(), "cb-paths-"));
  jest.spyOn(console, "error").mockImplementation(() => {});
  return home;
}

describe("paths", () => {
  it("uses ~/.config/lazygate", () => {
    setup();
    expect(APP_NAME).toBe("lazygate");
    expect(configDir(home)).toBe(join(home, ".config", "lazygate"));
  });

  it("moves a legacy config dir once and leaves a symlink", () => {
    setup();
    mkdirSync(join(home, ".config", "context-broker"), { recursive: true });
    writeFileSync(join(home, ".config", "context-broker", "servers.json"), "{}");

    expect(adoptLegacyConfigDir(home)).toBe(true);
    expect(readFileSync(join(home, ".config", "lazygate", "servers.json"), "utf-8")).toBe("{}");
    expect(lstatSync(join(home, ".config", "context-broker")).isSymbolicLink()).toBe(true);
    // Reading through the old path still works
    expect(existsSync(join(home, ".config", "context-broker", "servers.json"))).toBe(true);

    expect(adoptLegacyConfigDir(home)).toBe(false); // idempotent
  });

  it("does nothing when the new dir already exists", () => {
    setup();
    mkdirSync(join(home, ".config", "context-broker"), { recursive: true });
    mkdirSync(join(home, ".config", "lazygate"), { recursive: true });
    expect(adoptLegacyConfigDir(home)).toBe(false);
    expect(lstatSync(join(home, ".config", "context-broker")).isDirectory()).toBe(true);
  });

  it("does nothing on a fresh machine", () => {
    setup();
    expect(adoptLegacyConfigDir(home)).toBe(false);
    expect(existsSync(join(home, ".config", "lazygate"))).toBe(false);
  });
});
