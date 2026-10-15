// src/skill-router.ts
// Scores and loads relevant skills based on a query

import { readFileSync, existsSync } from "fs";
import { parseSkillsConfig, reportConfigErrors } from "./config.js";
import { scoreEntry } from "./scoring.js";
import { LOG_PREFIX } from "./version.js";

export interface SkillConfig {
  description: string;
  keywords: string[];
  path: string;
  migratedFrom?: string;
  plugin?: string;
}

export interface SkillRouterResult {
  name: string;
  score: number;
  reason: string[];
  descriptionMatches: string[];
}

export class SkillRouter {
  private skills: Record<string, SkillConfig>;
  private readonly configPath?: string;

  constructor(skills: Record<string, SkillConfig>, configPath?: string) {
    this.skills = skills;
    this.configPath = configPath;
  }

  /** Re-read skills.json (session-sync rewrites it at every session start). */
  reloadFromDisk(): boolean {
    if (!this.configPath) return false;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf-8"));
      const { entries, errors } = parseSkillsConfig(raw, this.configPath);
      reportConfigErrors(errors);
      this.skills = entries;
      return true;
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Could not reload ${this.configPath}: ${(err as Error).message} — keeping previous skills`
      );
      return false;
    }
  }

  rank(query: string): SkillRouterResult[] {
    const results: SkillRouterResult[] = [];

    for (const [name, config] of Object.entries(this.skills)) {
      const s = scoreEntry(query, config);
      if (s.score > 0) {
        results.push({
          name,
          score: s.score,
          reason: s.keywords,
          descriptionMatches: s.descriptionWords,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  load(skillName: string): string {
    const skill = this.skills[skillName];
    if (!skill) {
      throw new Error(
        `Unknown skill: "${skillName}". Available: ${Object.keys(this.skills).join(", ")}`
      );
    }

    // Prefer INSTRUCTIONS.md (body split from SKILL.md) if present
    const instructionsPath = skill.path.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
    const loadPath = existsSync(instructionsPath) ? instructionsPath : skill.path;

    if (!existsSync(loadPath)) {
      throw new Error(`Skill file not found: ${loadPath}`);
    }

    return readFileSync(loadPath, "utf-8");
  }

  getConfig(name: string): SkillConfig | undefined {
    return this.skills[name];
  }

  listAll(): string[] {
    return Object.keys(this.skills);
  }
}
