import { describe, it, expect } from "vitest";
import { z } from "zod";

import { defineTool } from "../types/tool.js";
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "../types/messages.js";
import type { AgentEvent, Terminal } from "../types/events.js";
import type { ProviderEvent, ProviderRequest, ToolSchema } from "../types/provider.js";
import { EMPTY_USAGE } from "../types/usage.js";

describe("defineTool", () => {
  it("preserves name/description and produces a usable Zod inputSchema", () => {
    const tool = defineTool({
      name: "read_path",
      description: "Echoes back the given path.",
      inputSchema: z.object({ path: z.string() }),
      call: async ({ path }) => {
        // Generic-inference sentinel: this line type-checks ONLY if `path`
        // (destructured from the inferred input) is `string`. If defineTool's
        // `S` inference collapses to `any`/`unknown`, the @ts-expect-error
        // below becomes an *unused* directive and `tsc` fails the build —
        // guarding the inference contract at compile time.
        const _p: string = path;
        // @ts-expect-error path is a string, not a number — proves `input` is
        // strongly typed (not `any`). If inference breaks to `any`, this line
        // stops erroring and the directive is reported as unused.
        const _n: number = path;
        void _p;
        void _n;
        return path;
      },
    });

    expect(tool.name).toBe("read_path");
    expect(tool.description).toBe("Echoes back the given path.");
    expect(tool.inputSchema.safeParse({ path: "x" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ path: 123 }).success).toBe(false);
  });

  it("executes call with validated input", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ value: z.string() }),
      call: async ({ value }) => value.toUpperCase(),
    });
    const parsed = tool.inputSchema.parse({ value: "hi" });
    await expect(tool.call(parsed, {} as never, {})).resolves.toBe("HI");
  });
});

describe("type export surface (compile-time literal construction)", () => {
  it("constructs each public shape so renamed exports / changed required fields break the build", () => {
    const text: TextBlock = { type: "text", text: "hi" };
    const toolUse: ToolUseBlock = { type: "tool_use", id: "t1", name: "read", input: { path: "x" } };
    const toolResult: ToolResultBlock = { type: "tool_result", tool_use_id: "t1", content: "ok" };
    const blocks: ContentBlock[] = [text, toolUse, toolResult];

    const message: Message = { role: "assistant", content: blocks };

    const agentDone: AgentEvent = { type: "agent_done", messages: [message], usage: EMPTY_USAGE };

    // tool_use ProviderEvent WITH the refined-design `inputParseError` field —
    // asserts the optional flag exists on the type (no PARSE_ERROR sentinel).
    const providerToolUse: ProviderEvent = {
      type: "tool_use",
      id: "t1",
      name: "read",
      input: {},
      inputParseError: true,
    };

    const terminal: Terminal = { reason: "agent_done", messages: [message], usage: EMPTY_USAGE };

    const request: ProviderRequest = {
      systemPrompt: "sys",
      messages: [message],
      tools: [] as ToolSchema[],
    };

    expect(message.role).toBe("assistant");
    expect(agentDone.type).toBe("agent_done");
    expect(providerToolUse.type).toBe("tool_use");
    expect(providerToolUse.inputParseError).toBe(true);
    expect(terminal.reason).toBe("agent_done");
    expect(request.messages).toHaveLength(1);
  });
});
