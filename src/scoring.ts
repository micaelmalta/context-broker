// src/scoring.ts
// Shared query → entry scoring used by ToolRouter and SkillRouter.
// Matching is token based (whole words, light plural stemming) so that short
// keywords such as "git" or "pr" do not fire on "digital" or "prompt".

export interface Scorable {
  description?: string;
  keywords?: string[];
  /** Tool names + descriptions learned from the server (see tool-index.ts). */
  toolText?: string;
}

/** Tool-derived matches are weak evidence (common verbs everywhere), so they are capped. */
const MAX_TOOL_SCORE = 2;

export interface ScoreResult {
  score: number;
  /** Keywords that matched the query. */
  keywords: string[];
  /** Description words (longer than 4 chars) that matched the query. */
  descriptionWords: string[];
  /** Words from the server's tool names/descriptions that matched (score capped at 2). */
  toolWords: string[];
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).map(stem);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function scoreEntry(query: string, entry: Scorable): ScoreResult {
  const queryTokens = tokenize(query);
  const querySet = new Set(queryTokens);

  const keywords = (entry.keywords ?? []).filter((kw) =>
    containsSequence(queryTokens, tokenize(kw))
  );

  const seen = new Set<string>();
  const descriptionWords: string[] = [];
  for (const raw of (entry.description ?? "").toLowerCase().match(TOKEN_RE) ?? []) {
    if (raw.length <= 4) continue;
    const word = stem(raw);
    if (seen.has(word)) continue;
    seen.add(word);
    if (querySet.has(word)) descriptionWords.push(raw);
  }

  const toolWords: string[] = [];
  if (entry.toolText) {
    const known = new Set([...seen, ...keywords.flatMap(tokenize)]);
    for (const raw of entry.toolText.toLowerCase().match(TOKEN_RE) ?? []) {
      if (raw.length <= 4) continue;
      const word = stem(raw);
      if (known.has(word)) continue;
      known.add(word);
      if (querySet.has(word)) toolWords.push(raw);
    }
  }

  return {
    score:
      keywords.length * 2 +
      descriptionWords.length +
      Math.min(toolWords.length, MAX_TOOL_SCORE),
    keywords,
    descriptionWords,
    toolWords,
  };
}
