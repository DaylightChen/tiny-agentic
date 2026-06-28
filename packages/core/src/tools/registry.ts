import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "../types/tool.js";
import type { ToolSchema } from "../types/provider.js";

export class ToolRegistry {
  private readonly byName: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  findByName(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  toSchemas(): ToolSchema[] {
    return Array.from(this.byName.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema, {
        target: "openApi3",
        $refStrategy: "none", // inline all refs for Anthropic compatibility
      }) as ToolSchema["inputSchema"],
    }));
  }
}
