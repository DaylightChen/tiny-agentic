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
    return Array.from(this.byName.values()).map((tool) => {
      // jsonSchema7 (not openApi3): the openApi3/Draft-4 target emits boolean
      // `exclusiveMinimum: true`, which OpenAI's function-parameters metaschema
      // rejects ("True is not of type 'number'"). jsonSchema7 emits the numeric
      // Draft-7 form (`exclusiveMinimum: 0`) that BOTH Anthropic and OpenAI accept.
      // $refStrategy: "none" inlines all refs (providers do not resolve $ref).
      const json = zodToJsonSchema(tool.inputSchema, {
        target: "jsonSchema7",
        $refStrategy: "none",
      }) as Record<string, unknown>;
      // Strip the draft marker — providers don't need it, and it keeps schemas clean.
      delete json["$schema"];
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: json as ToolSchema["inputSchema"],
      };
    });
  }
}
