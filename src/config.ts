// src/config.ts
// Runtime validation for servers.json / skills.json (entries that fail
// validation are skipped and reported with the offending entry's name).

import { z } from "zod";
import type { ServerConfig } from "./router.js";
import type { SkillConfig } from "./skill-router.js";

const OAuthSchema = z.union([
  z.boolean(),
  z
    .object({
      clientId: z.string().optional(),
      callbackPort: z.number().int().min(0).max(65535).optional(),
      scopes: z.array(z.string()).optional(),
    })
    .strict(),
]);

const AuthSchema = z
  .object({
    scope: z.enum(["user", "server"]).optional(),
    fallback: z.literal("server").optional(),
    env: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const ServerSchema = z
  .object({
    description: z.string().default(""),
    keywords: z.array(z.string()).default([]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    type: z.enum(["http", "stdio"]).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    oauth: OAuthSchema.optional(),
    autoActivate: z.boolean().default(false),
    inheritEnv: z.union([z.boolean(), z.array(z.string())]).optional(),
    auth: AuthSchema.optional(),
    groups: z.array(z.string()).optional(),
    toolTimeoutMs: z.number().int().positive().optional(),
    migratedFrom: z.string().optional(),
    disabledPlugins: z.array(z.string()).optional(),
  })
  .passthrough()
  .refine((c) => Boolean(c.command) || Boolean(c.url), {
    message: "must define either `command` (stdio) or `url` (http)",
  });

const SkillSchema = z
  .object({
    description: z.string().default(""),
    keywords: z.array(z.string()).default([]),
    path: z.string().min(1),
    migratedFrom: z.string().optional(),
    plugin: z.string().optional(),
  })
  .passthrough();

export interface ParseResult<T> {
  entries: Record<string, T>;
  errors: string[];
}

function parseEntries<T>(
  raw: unknown,
  key: "servers" | "skills",
  schema: z.ZodTypeAny,
  source: string
): ParseResult<T> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const table = (raw as Record<string, unknown>)[key];
  if (table === undefined) return { entries: {}, errors: [] };
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error(`${source}: "${key}" must be an object keyed by name`);
  }

  const entries: Record<string, T> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(table)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      entries[name] = parsed.data as T;
    } else {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(entry)"}: ${i.message}`)
        .join("; ");
      errors.push(`${source}: ${key}.${name} — ${detail}`);
    }
  }
  return { entries, errors };
}

export function parseServersConfig(raw: unknown, source = "servers.json"): ParseResult<ServerConfig> {
  return parseEntries<ServerConfig>(raw, "servers", ServerSchema, source);
}

export function parseSkillsConfig(raw: unknown, source = "skills.json"): ParseResult<SkillConfig> {
  return parseEntries<SkillConfig>(raw, "skills", SkillSchema, source);
}

const reported = new Set<string>();

/** Log config errors to stderr, once per distinct message (reloads would otherwise repeat them). */
export function reportConfigErrors(errors: string[], prefix = "[lazygate]"): void {
  for (const e of errors) {
    if (reported.has(e)) continue;
    reported.add(e);
    console.error(`${prefix} skipping invalid entry — ${e}`);
  }
}
