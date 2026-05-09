// src/skill-router.ts
// Scores and loads relevant skills based on a query

import { readFileSync, existsSync } from "fs";

export interface SkillConfig {
  description: string;
  keywords: string[];
  path: string;
}

export interface SkillRouterResult {
  name: string;
  score: number;
  reason: string[];
}

export class SkillRouter {
  private skills: Record<string, SkillConfig>;

  constructor(skills: Record<string, SkillConfig>) {
    this.skills = skills;
  }

  rank(query: string): SkillRouterResult[] {
    const q = query.toLowerCase();
    const results: SkillRouterResult[] = [];

    for (const [name, config] of Object.entries(this.skills)) {
      const matchedKeywords = config.keywords.filter(kw =>
        q.includes(kw.toLowerCase())
      );

      const descWords = config.description.toLowerCase().split(/\s+/);
      const descMatches = descWords.filter(w => w.length > 4 && q.includes(w));

      const score = (matchedKeywords.length * 2) + descMatches.length;

      if (score > 0) {
        results.push({ name, score, reason: matchedKeywords });
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
