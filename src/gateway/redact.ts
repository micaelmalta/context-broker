// src/gateway/redact.ts
// Keeps credential values out of tool results, errors and logs.

const MIN_SECRET_LENGTH = 6; // shorter values would shred ordinary text

export class Redactor {
  private values = new Set<string>();

  add(values: Iterable<string | undefined>): void {
    for (const v of values) if (v && v.length >= MIN_SECRET_LENGTH) this.values.add(v);
  }

  text(input: string): string {
    let out = input;
    // Longest first so a secret that contains another is replaced whole.
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join("[redacted]");
    }
    return out;
  }

  /** Redact the text parts of an MCP tool result (and any other string fields, shallowly). */
  result<T extends { content: unknown[] }>(result: T): T {
    if (this.values.size === 0) return result;
    const content = result.content.map((c) => {
      if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
        return { ...(c as object), text: this.text((c as { text: string }).text) };
      }
      return c;
    });
    return { ...result, content };
  }
}
