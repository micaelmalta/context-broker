// src/__tests__/router.test.ts
// Unit tests for ToolRouter (src/router.ts)

import { ToolRouter, ServerConfig, RouterResult } from '../router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    description: 'A generic test server',
    keywords: [],
    autoActivate: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor / basic shape
// ---------------------------------------------------------------------------

describe('ToolRouter – construction', () => {
  it('can be instantiated with an empty registry', () => {
    const router = new ToolRouter({});
    expect(router).toBeInstanceOf(ToolRouter);
  });

  it('can be instantiated with a populated registry', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub integration', keywords: ['github', 'repo'] }),
    });
    expect(router).toBeInstanceOf(ToolRouter);
  });
});

// ---------------------------------------------------------------------------
// listAll()
// ---------------------------------------------------------------------------

describe('ToolRouter.listAll()', () => {
  it('returns empty array for empty registry', () => {
    const router = new ToolRouter({});
    expect(router.listAll()).toEqual([]);
  });

  it('returns all server names', () => {
    const router = new ToolRouter({
      alpha: makeServer(),
      beta: makeServer(),
      gamma: makeServer(),
    });
    expect(router.listAll().sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns names in insertion order', () => {
    const router = new ToolRouter({
      first: makeServer(),
      second: makeServer(),
      third: makeServer(),
    });
    expect(router.listAll()).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// getConfig()
// ---------------------------------------------------------------------------

describe('ToolRouter.getConfig()', () => {
  const config: ServerConfig = {
    description: 'GitHub server',
    keywords: ['github'],
    autoActivate: true,
    command: 'npx',
    args: ['github-mcp'],
  };

  const router = new ToolRouter({ github: config });

  it('returns the config for a known server', () => {
    expect(router.getConfig('github')).toEqual(config);
  });

  it('returns undefined for an unknown server', () => {
    expect(router.getConfig('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rank() – empty registry
// ---------------------------------------------------------------------------

describe('ToolRouter.rank() – empty registry', () => {
  it('returns empty array', () => {
    const router = new ToolRouter({});
    expect(router.rank('search github')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rank() – no matches
// ---------------------------------------------------------------------------

describe('ToolRouter.rank() – no matches', () => {
  it('returns empty array when query matches nothing', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub integration', keywords: ['github', 'repo'] }),
    });
    expect(router.rank('completely unrelated xyz')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rank() – keyword matching
// ---------------------------------------------------------------------------

describe('ToolRouter.rank() – keyword matching', () => {
  it('matches a server by an exact keyword in the query', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'Source control', keywords: ['github'] }),
    });
    const results = router.rank('search github issues');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('github');
  });

  it('is case-insensitive for keywords', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'Source control', keywords: ['GitHub'] }),
    });
    const results = router.rank('search github issues');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('github');
  });

  it('is case-insensitive for the query', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'Source control', keywords: ['github'] }),
    });
    const results = router.rank('Search GITHUB Issues');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('github');
  });

  it('each matched keyword contributes +2 to the score', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'Source control', keywords: ['github', 'repo', 'pull'] }),
    });
    // query matches 2 keywords → score should be at least 4
    const results = router.rank('github repo');
    expect(results[0].score).toBe(4);
  });

  it('includes matched keywords in the reason array', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'Source control', keywords: ['github', 'repo'] }),
    });
    const results = router.rank('github repo management');
    expect(results[0].reason).toEqual(expect.arrayContaining(['github', 'repo']));
    expect(results[0].reason).toHaveLength(2);
  });

  it('reason only lists keywords that were actually matched', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'Source control', keywords: ['github', 'jira', 'linear'] }),
    });
    const results = router.rank('github pull request');
    expect(results[0].reason).toEqual(['github']);
  });
});

// ---------------------------------------------------------------------------
// rank() – description word matching
// ---------------------------------------------------------------------------

describe('ToolRouter.rank() – description word matching', () => {
  it('matches description words longer than 4 characters', () => {
    // "integration" (11 chars) is in description and query
    const router = new ToolRouter({
      myserver: makeServer({ description: 'GitHub integration tool', keywords: [] }),
    });
    const results = router.rank('test integration endpoint');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('myserver');
  });

  it('does NOT match description words of 4 characters or fewer', () => {
    // "tool" is exactly 4 chars — should not match
    const router = new ToolRouter({
      myserver: makeServer({ description: 'test tool only', keywords: [] }),
    });
    const results = router.rank('tool');
    expect(results).toHaveLength(0);
  });

  it('each matched description word contributes +1 to the score', () => {
    // one description word match → score 1
    const router = new ToolRouter({
      myserver: makeServer({ description: 'GitHub integration tool', keywords: [] }),
    });
    const results = router.rank('integration');
    expect(results[0].score).toBe(1);
  });

  it('combined keyword + description scoring is additive', () => {
    // keyword: ['search'] (+2 for 'search')
    // description: 'Integration service' — 'integration' (>4 chars, in query) → +1
    // total: 3
    const router = new ToolRouter({
      myserver: makeServer({ description: 'Integration service', keywords: ['search'] }),
    });
    const results = router.rank('search integration');
    expect(results[0].score).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// rank() – ranking order
// ---------------------------------------------------------------------------

describe('ToolRouter.rank() – ranking order', () => {
  it('returns servers sorted by descending score', () => {
    const router = new ToolRouter({
      lowMatch: makeServer({ description: 'Search engine service', keywords: ['search'] }),
      highMatch: makeServer({ description: 'GitHub source control', keywords: ['github', 'source', 'control'] }),
    });
    const results = router.rank('github source control search');
    expect(results[0].name).toBe('highMatch');
    expect(results[1].name).toBe('lowMatch');
  });

  it('a single matching server is the only result', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
      jira: makeServer({ description: 'Issue tracker', keywords: ['jira'] }),
    });
    const results = router.rank('github repo');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('github');
  });

  it('all matching servers are returned (not just top-1)', () => {
    const router = new ToolRouter({
      a: makeServer({ description: 'Alpha service', keywords: ['alpha'] }),
      b: makeServer({ description: 'Beta service', keywords: ['beta'] }),
      c: makeServer({ description: 'Gamma service', keywords: ['gamma'] }),
    });
    const results = router.rank('alpha beta gamma');
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// rank() – ties
// ---------------------------------------------------------------------------

describe('ToolRouter.rank() – ties', () => {
  it('returns tied servers (both present in results)', () => {
    const router = new ToolRouter({
      serverA: makeServer({ description: 'Generic server one', keywords: ['search'] }),
      serverB: makeServer({ description: 'Generic server two', keywords: ['search'] }),
    });
    const results = router.rank('search');
    expect(results).toHaveLength(2);
    // Both should have the same score
    expect(results[0].score).toBe(results[1].score);
  });
});

// ---------------------------------------------------------------------------
// select()
// ---------------------------------------------------------------------------

describe('ToolRouter.select()', () => {
  it('returns empty array when there are no matches', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    expect(router.select('completely unrelated')).toEqual([]);
  });

  it('returns top-3 server names by default', () => {
    const router = new ToolRouter({
      a: makeServer({ description: 'Service alpha beta', keywords: ['alpha', 'beta'] }),
      b: makeServer({ description: 'Service beta gamma', keywords: ['beta', 'gamma'] }),
      c: makeServer({ description: 'Service delta', keywords: ['delta'] }),
      d: makeServer({ description: 'Service alpha', keywords: ['alpha'] }),
    });
    const results = router.select('alpha beta gamma delta');
    expect(results).toHaveLength(3);
  });

  it('respects a custom topK value', () => {
    const router = new ToolRouter({
      a: makeServer({ description: 'Service one', keywords: ['service'] }),
      b: makeServer({ description: 'Service two', keywords: ['service'] }),
      c: makeServer({ description: 'Service three', keywords: ['service'] }),
      d: makeServer({ description: 'Service four', keywords: ['service'] }),
      e: makeServer({ description: 'Service five', keywords: ['service'] }),
    });
    expect(router.select('service', 1)).toHaveLength(1);
    expect(router.select('service', 2)).toHaveLength(2);
    expect(router.select('service', 5)).toHaveLength(5);
  });

  it('returns fewer results than topK when fewer servers match', () => {
    const router = new ToolRouter({
      only: makeServer({ description: 'Unique service', keywords: ['unique'] }),
    });
    expect(router.select('unique', 10)).toHaveLength(1);
  });

  it('returns server names (not scores) as strings', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    const results = router.select('github');
    expect(results).toEqual(['github']);
  });

  it('returns names in descending score order', () => {
    const router = new ToolRouter({
      weak: makeServer({ description: 'GitHub service', keywords: ['github'] }),
      strong: makeServer({ description: 'GitHub source control', keywords: ['github', 'source', 'control'] }),
    });
    const results = router.select('github source control', 2);
    expect(results[0]).toBe('strong');
    expect(results[1]).toBe('weak');
  });

  it('topK=0 returns empty array', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    expect(router.select('github', 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// explain()
// ---------------------------------------------------------------------------

describe('ToolRouter.explain()', () => {
  it('returns "No servers matched" message when no servers match', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    expect(router.explain('unrelated query')).toBe('No servers matched this query.');
  });

  it('returns "No servers matched" for empty registry', () => {
    const router = new ToolRouter({});
    expect(router.explain('anything')).toBe('No servers matched this query.');
  });

  it('includes matched server name in the output', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    const explanation = router.explain('github issues');
    expect(explanation).toContain('github');
  });

  it('includes the score in the output', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    const explanation = router.explain('github issues');
    expect(explanation).toMatch(/score:/);
  });

  it('includes matched keywords in the output', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github', 'repo'] }),
    });
    const explanation = router.explain('github repo');
    expect(explanation).toContain('github');
    expect(explanation).toContain('repo');
  });

  it('shows at most 5 results', () => {
    const servers: Record<string, ServerConfig> = {};
    for (let i = 0; i < 10; i++) {
      servers[`server${i}`] = makeServer({ description: 'Generic service', keywords: ['service'] });
    }
    const router = new ToolRouter(servers);
    const lines = router.explain('service').split('\n');
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('returns a multi-line string when multiple servers match', () => {
    const router = new ToolRouter({
      a: makeServer({ description: 'Alpha service', keywords: ['alpha'] }),
      b: makeServer({ description: 'Beta service', keywords: ['beta'] }),
    });
    const explanation = router.explain('alpha beta');
    expect(explanation).toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Edge cases / integration
// ---------------------------------------------------------------------------

describe('ToolRouter – edge cases', () => {
  it('handles a query that is an empty string', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    expect(router.rank('')).toEqual([]);
    expect(router.select('')).toEqual([]);
    expect(router.explain('')).toBe('No servers matched this query.');
  });

  it('handles servers with empty keyword arrays', () => {
    const router = new ToolRouter({
      noKeywords: makeServer({ description: 'Integration service for testing', keywords: [] }),
    });
    // "integration" and "service" and "testing" are >4 chars and appear in query
    const results = router.rank('testing integration service');
    expect(results).toHaveLength(1);
    expect(results[0].reason).toEqual([]); // no keywords matched
  });

  it('a query matching only description words (no keywords) still returns a result', () => {
    const router = new ToolRouter({
      myserver: makeServer({ description: 'Powerful search engine service', keywords: [] }),
    });
    const results = router.rank('search engine powerful');
    expect(results.length).toBeGreaterThan(0);
  });

  it('single server in registry that matches is returned', () => {
    const router = new ToolRouter({
      solo: makeServer({ description: 'The only server', keywords: ['solo'] }),
    });
    const results = router.rank('solo task');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('solo');
  });

  it('score is never negative', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service integration', keywords: ['github', 'repo'] }),
    });
    const results = router.rank('github integration');
    expect(results.every(r => r.score >= 0)).toBe(true);
  });

  it('does not mutate the original config object', () => {
    const original = { description: 'GitHub service', keywords: ['github'], autoActivate: false };
    const router = new ToolRouter({ github: original });
    router.rank('github');
    expect(original.keywords).toEqual(['github']);
  });

  it('handles a server whose description is an empty string', () => {
    const router = new ToolRouter({
      emptyDesc: makeServer({ description: '', keywords: ['search'] }),
    });
    const results = router.rank('search');
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(2);
  });

  it('rank result objects have name, score, and reason fields', () => {
    const router = new ToolRouter({
      github: makeServer({ description: 'GitHub service', keywords: ['github'] }),
    });
    const results = router.rank('github');
    const r = results[0] as RouterResult;
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('reason');
    expect(typeof r.name).toBe('string');
    expect(typeof r.score).toBe('number');
    expect(Array.isArray(r.reason)).toBe(true);
  });
});
