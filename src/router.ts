// src/router.ts
// Scores and selects relevant servers based on a query

export interface ServerConfig {
  description: string;
  keywords: string[];
  // stdio transport (default)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport
  type?: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  oauth?: { clientId: string; callbackPort: number; scopes?: string[] };
  autoActivate: boolean;
}

export interface RouterResult {
  name: string;
  score: number;
  reason: string[];
}

export class ToolRouter {
  private servers: Record<string, ServerConfig>;

  constructor(servers: Record<string, ServerConfig>) {
    this.servers = servers;
  }

  /**
   * Score all servers against a query.
   * Returns ranked list with scores and match reasons.
   */
  rank(query: string): RouterResult[] {
    const q = query.toLowerCase();
    const results: RouterResult[] = [];

    for (const [name, config] of Object.entries(this.servers)) {
      const matchedKeywords = config.keywords.filter(kw =>
        q.includes(kw.toLowerCase())
      );

      // Also check description words
      const descWords = config.description.toLowerCase().split(/\s+/);
      const descMatches = descWords.filter(w =>
        w.length > 4 && q.includes(w)
      );

      const score = (matchedKeywords.length * 2) + descMatches.length;

      if (score > 0) {
        results.push({
          name,
          score,
          reason: matchedKeywords
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Select top-k servers for a query.
   */
  select(query: string, topK = 3): string[] {
    const ranked = this.rank(query);
    return ranked.slice(0, topK).map(r => r.name);
  }

  /**
   * Get a human-readable explanation of why servers were selected.
   */
  explain(query: string): string {
    const ranked = this.rank(query);
    if (ranked.length === 0) {
      return "No servers matched this query.";
    }

    return ranked
      .slice(0, 5)
      .map(r => `${r.name} (score: ${r.score}, matched: ${r.reason.join(", ")})`)
      .join("\n");
  }

  getConfig(name: string): ServerConfig | undefined {
    return this.servers[name];
  }

  listAll(): string[] {
    return Object.keys(this.servers);
  }
}
