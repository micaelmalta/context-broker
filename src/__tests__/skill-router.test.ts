// src/__tests__/skill-router.test.ts
// Comprehensive unit tests for SkillRouter

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ── fs mock setup (must happen before dynamic import of skill-router) ─────────
const mockExistsSync = jest.fn<(path: string) => boolean>();
const mockReadFileSync = jest.fn<(path: string, encoding: string) => string>();

jest.unstable_mockModule("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

// Dynamic import after mock registration
const { SkillRouter } = await import("../skill-router.js");
type SkillConfig = import("../skill-router.js").SkillConfig;

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSkillConfig(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    description: "A generic skill",
    keywords: [],
    path: "/skills/generic/SKILL.md",
    ...overrides,
  };
}

function makeSampleRegistry(): Record<string, SkillConfig> {
  return {
    docx: {
      description: "Create and edit Microsoft Word documents",
      keywords: ["word", "document", "docx"],
      path: "/skills/docx/SKILL.md",
    },
    search: {
      description: "Search the web for information",
      keywords: ["search", "web", "query"],
      path: "/skills/search/SKILL.md",
    },
    translate: {
      description: "Translate text between languages",
      keywords: ["translate", "language", "locale"],
      path: "/skills/translate/SKILL.md",
    },
  };
}

// ── SkillRouter.rank() ────────────────────────────────────────────────────────

describe("SkillRouter.rank()", () => {
  it("returns results sorted by descending score", () => {
    const router = new SkillRouter(makeSampleRegistry());
    const results = router.rank("search the web");
    expect(results.length).toBeGreaterThan(0);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it("returns an empty array for empty registry", () => {
    const router = new SkillRouter({});
    expect(router.rank("create a document")).toEqual([]);
  });

  it("returns an empty array when no skill matches the query", () => {
    const router = new SkillRouter(makeSampleRegistry());
    expect(router.rank("completely unrelated xyz")).toEqual([]);
  });

  it("scores keyword matches at 2 points each", () => {
    const registry = {
      docx: makeSkillConfig({
        description: "no overlap here",
        keywords: ["word"],
      }),
    };
    const router = new SkillRouter(registry);
    const [result] = router.rank("word");
    // one keyword match → score = 2
    expect(result.score).toBe(2);
  });

  it("scores description word matches at 1 point each (words > 4 chars)", () => {
    const registry = {
      skill: makeSkillConfig({
        description: "process images quickly",
        keywords: [],
      }),
    };
    const router = new SkillRouter(registry);
    // "process" (7 chars) and "images" (6 chars) are both > 4 chars and appear in query
    // "quickly" not in query, "now" ≤4 chars
    const [result] = router.rank("process images now");
    expect(result.score).toBe(2);
  });

  it("ignores description words with 4 or fewer characters", () => {
    const registry = {
      skill: makeSkillConfig({
        description: "run this now",
        keywords: [],
      }),
    };
    const router = new SkillRouter(registry);
    // "run"(3), "this"(4), "now"(3) — all ≤4 chars, none score
    const results = router.rank("run this now");
    expect(results).toEqual([]);
  });

  it("combines keyword and description scores", () => {
    const registry = {
      docx: makeSkillConfig({
        description: "create Microsoft Word documents",
        keywords: ["word"],
      }),
    };
    const router = new SkillRouter(registry);
    // keyword "word" → 2 pts
    // desc words >4 in query "create word documents":
    //   "create"(6) in query ✓, "microsoft"(9) not in query ✗, "word"(4) ≤4 skip, "documents"(9) in query ✓
    // → desc matches = 2
    const [result] = router.rank("create word documents");
    expect(result.score).toBe(4); // 2 (keyword) + 2 (desc)
  });

  it("includes matched keywords in the reason array", () => {
    const router = new SkillRouter(makeSampleRegistry());
    const results = router.rank("translate some language");
    const translateResult = results.find(r => r.name === "translate");
    expect(translateResult).toBeDefined();
    expect(translateResult!.reason).toContain("translate");
    expect(translateResult!.reason).toContain("language");
  });

  it("does not include non-matching keywords in reason", () => {
    const registry = {
      docx: makeSkillConfig({
        keywords: ["word", "document", "pdf"],
        description: "",
      }),
    };
    const router = new SkillRouter(registry);
    const [result] = router.rank("word only");
    expect(result.reason).toEqual(["word"]);
    expect(result.reason).not.toContain("document");
    expect(result.reason).not.toContain("pdf");
  });

  it("is case-insensitive for keyword matching", () => {
    const registry = {
      docx: makeSkillConfig({
        keywords: ["Word", "Document"],
        description: "",
      }),
    };
    const router = new SkillRouter(registry);
    const results = router.rank("WORD document");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("docx");
    expect(results[0].score).toBe(4); // both keywords matched
  });

  it("is case-insensitive for description matching", () => {
    const registry = {
      skill: makeSkillConfig({
        description: "Process Images Quickly",
        keywords: [],
      }),
    };
    const router = new SkillRouter(registry);
    const [result] = router.rank("PROCESS IMAGES");
    expect(result.score).toBe(2); // "process" + "images"
  });

  it("handles single-skill registry returning that skill when matched", () => {
    const registry = {
      only: makeSkillConfig({ keywords: ["unique"], description: "" }),
    };
    const router = new SkillRouter(registry);
    const results = router.rank("unique query");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("only");
  });

  it("handles ties — both results appear with same score", () => {
    const registry = {
      skillA: makeSkillConfig({ keywords: ["alpha"], description: "" }),
      skillB: makeSkillConfig({ keywords: ["alpha"], description: "" }),
    };
    const router = new SkillRouter(registry);
    const results = router.rank("alpha query");
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(results[1].score);
    expect(results.map(r => r.name).sort()).toEqual(["skillA", "skillB"]);
  });

  it("returns correct SkillRouterResult shape", () => {
    const router = new SkillRouter(makeSampleRegistry());
    const [result] = router.rank("search");
    expect(result).toHaveProperty("name");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("reason");
    expect(typeof result.name).toBe("string");
    expect(typeof result.score).toBe("number");
    expect(Array.isArray(result.reason)).toBe(true);
  });

  it("excludes skills with zero score", () => {
    const registry = {
      matched: makeSkillConfig({ keywords: ["found"], description: "" }),
      unmatched: makeSkillConfig({ keywords: ["missing"], description: "" }),
    };
    const router = new SkillRouter(registry);
    const results = router.rank("found");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("matched");
  });

  it("ranks multiple matching skills by score descending", () => {
    const registry = {
      // matches "word"(kw) + "document"(kw) = 4pts
      docx: makeSkillConfig({
        keywords: ["word", "document"],
        description: "",
      }),
      // matches "word"(kw) only = 2pts
      wordpad: makeSkillConfig({
        keywords: ["word"],
        description: "",
      }),
    };
    const router = new SkillRouter(registry);
    const results = router.rank("word document");
    expect(results[0].name).toBe("docx");
    expect(results[1].name).toBe("wordpad");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("handles a query that matches only via description (no keyword match)", () => {
    const registry = {
      imager: makeSkillConfig({
        keywords: ["something-else"],
        description: "resize photos batch process",
      }),
    };
    const router = new SkillRouter(registry);
    // "resize"(6), "photos"(6), "batch"(5), "process"(7) all >4 chars
    // query contains "resize" and "process" → desc score = 2
    const results = router.rank("resize and process files");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("imager");
    expect(results[0].score).toBe(2);
  });
});

// ── SkillRouter.load() ────────────────────────────────────────────────────────

describe("SkillRouter.load()", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  it("throws for an unknown skill name", () => {
    const router = new SkillRouter(makeSampleRegistry());
    expect(() => router.load("nonexistent")).toThrow(/Unknown skill: "nonexistent"/);
  });

  it("error message for unknown skill lists available skills", () => {
    const router = new SkillRouter(makeSampleRegistry());
    expect(() => router.load("ghost")).toThrow(/Available: /);
  });

  it("loads from SKILL.md when INSTRUCTIONS.md does not exist", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("INSTRUCTIONS.md")) return false;
      if (p.endsWith("SKILL.md")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("skill content from SKILL.md");

    const router = new SkillRouter(makeSampleRegistry());
    const content = router.load("docx");
    expect(content).toBe("skill content from SKILL.md");
    expect(mockReadFileSync).toHaveBeenCalledWith("/skills/docx/SKILL.md", "utf-8");
  });

  it("prefers INSTRUCTIONS.md over SKILL.md when it exists", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("INSTRUCTIONS.md")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("instructions content");

    const router = new SkillRouter(makeSampleRegistry());
    const content = router.load("docx");
    expect(content).toBe("instructions content");
    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/skills/docx/INSTRUCTIONS.md",
      "utf-8"
    );
  });

  it("throws when neither SKILL.md nor INSTRUCTIONS.md exists", () => {
    mockExistsSync.mockReturnValue(false);

    const router = new SkillRouter(makeSampleRegistry());
    expect(() => router.load("docx")).toThrow(/Skill file not found/);
  });

  it("error message includes the file path when not found", () => {
    mockExistsSync.mockReturnValue(false);

    const router = new SkillRouter(makeSampleRegistry());
    expect(() => router.load("docx")).toThrow(/\/skills\/docx\//);
  });

  it("handles path that does not end with SKILL.md (INSTRUCTIONS fallback = same path)", () => {
    const registry = {
      custom: makeSkillConfig({ path: "/skills/custom/instructions.md" }),
    };
    mockExistsSync.mockImplementation((p: string) => {
      return p === "/skills/custom/instructions.md";
    });
    mockReadFileSync.mockReturnValue("custom skill content");

    const router = new SkillRouter(registry);
    const content = router.load("custom");
    expect(content).toBe("custom skill content");
  });

  it("returns the full file content as a string", () => {
    mockExistsSync.mockReturnValue(true);
    const expected = "# My Skill\n\nThis is the skill body.\n";
    mockReadFileSync.mockReturnValue(expected);

    const router = new SkillRouter(makeSampleRegistry());
    expect(router.load("search")).toBe(expected);
  });

  it("only reads the file once per load() call", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("content");

    const router = new SkillRouter(makeSampleRegistry());
    router.load("translate");
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });
});

// ── SkillRouter.getConfig() ───────────────────────────────────────────────────

describe("SkillRouter.getConfig()", () => {
  it("returns the config for a known skill", () => {
    const registry = makeSampleRegistry();
    const router = new SkillRouter(registry);
    expect(router.getConfig("docx")).toEqual(registry.docx);
  });

  it("returns undefined for an unknown skill", () => {
    const router = new SkillRouter(makeSampleRegistry());
    expect(router.getConfig("nonexistent")).toBeUndefined();
  });

  it("returns the correct config for each skill in the registry", () => {
    const registry = makeSampleRegistry();
    const router = new SkillRouter(registry);
    expect(router.getConfig("translate")).toEqual({
      description: "Translate text between languages",
      keywords: ["translate", "language", "locale"],
      path: "/skills/translate/SKILL.md",
    });
  });

  it("returns undefined for empty registry", () => {
    const router = new SkillRouter({});
    expect(router.getConfig("anything")).toBeUndefined();
  });
});

// ── SkillRouter.listAll() ─────────────────────────────────────────────────────

describe("SkillRouter.listAll()", () => {
  it("returns all skill names from the registry", () => {
    const router = new SkillRouter(makeSampleRegistry());
    expect(router.listAll().sort()).toEqual(["docx", "search", "translate"]);
  });

  it("returns an empty array for an empty registry", () => {
    const router = new SkillRouter({});
    expect(router.listAll()).toEqual([]);
  });

  it("returns a single-element array for a one-skill registry", () => {
    const router = new SkillRouter({ only: makeSkillConfig() });
    expect(router.listAll()).toEqual(["only"]);
  });

  it("count matches registry size", () => {
    const registry = makeSampleRegistry();
    const router = new SkillRouter(registry);
    expect(router.listAll()).toHaveLength(Object.keys(registry).length);
  });

  it("returns an array of strings", () => {
    const router = new SkillRouter(makeSampleRegistry());
    router.listAll().forEach(name => expect(typeof name).toBe("string"));
  });
});

// ── constructor ───────────────────────────────────────────────────────────────

describe("SkillRouter constructor", () => {
  it("accepts an empty registry without errors", () => {
    expect(() => new SkillRouter({})).not.toThrow();
  });

  it("accepts a populated registry without errors", () => {
    expect(() => new SkillRouter(makeSampleRegistry())).not.toThrow();
  });
});
