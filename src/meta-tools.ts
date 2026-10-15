// src/meta-tools.ts
// The six meta-tools the broker always exposes, plus their argument schemas.

import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const META_TOOLS: Tool[] = [
  {
    name: "discover_tools",
    description:
      "Find which tool servers are available and relevant for a task. " +
      "Call this first when you need a capability you don't have yet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Describe what you want to do" },
      },
      required: ["query"],
    },
  },
  {
    name: "activate_server",
    description:
      "Load and connect a tool server, making its tools available. " +
      "Call discover_tools first to find the right server name.",
    inputSchema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the server to activate" },
      },
      required: ["server_name"],
    },
  },
  {
    name: "deactivate_server",
    description: "Shut down a tool server to free resources.",
    inputSchema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the server to deactivate" },
      },
      required: ["server_name"],
    },
  },
  {
    name: "list_active_servers",
    description: "Show which servers are currently active and their tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "discover_skill",
    description:
      "Find the right skill for a task before executing it. " +
      "Call this at the start of any task that produces a file or " +
      "requires specialist knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do" },
      },
      required: ["query"],
    },
  },
  {
    name: "load_skill",
    description: "Load a skill's full instructions into context.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Name returned by discover_skill" },
      },
      required: ["skill_name"],
    },
  },
];

export const META_TOOL_NAMES = META_TOOLS.map((t) => t.name);

export const QuerySchema = z.object({ query: z.string().min(1, "`query` must be a non-empty string") });
export const ServerNameSchema = z.object({
  server_name: z.string().min(1, "`server_name` must be a non-empty string"),
});
export const SkillNameSchema = z.object({
  skill_name: z.string().min(1, "`skill_name` must be a non-empty string"),
});
