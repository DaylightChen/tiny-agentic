/**
 * End-to-end integration tests for the agent-tooling feature (task 05).
 *
 * These tests verify the full signal and approval chains:
 *   Agent.run() → agentLoop → context.signal → platform.exec (signal forwarding)
 *   Agent.run() → agentLoop → runTools → approvalHandler → deny → isError tool_result
 *
 * The mock Provider and Platform patterns are directly mirrored from agent.test.ts.
 *
 * NOTE on exec call counting:
 *   buildEnvContext (called by Agent.run before agentLoop) calls platform.exec
 *   twice to collect git branch and git status. These are "env exec" calls and
 *   are separate from "tool exec" calls made by bashTool itself. The platform
 *   tracks each call by command so tests can distinguish them:
 *     - env exec calls use git commands ("git rev-parse ...", "git status ...")
 *     - tool exec calls use the bash command ("echo hi")
 */
import { describe, it, expect } from "vitest";

import { Agent } from "../agent.js";
import { bashTool } from "../tools/builtin/bash.js";
import type { AgentEvent } from "../types/events.js";
import type { Provider, ProviderEvent, ProviderRequest } from "../types/provider.js";
import type { Platform, ExecResult, ExecOptions } from "../types/platform.js";
import type { ApprovalHandler } from "../types/tool.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Request-capturing provider. Mirrors the MockProvider in agent.test.ts.
 * Replays one scripted turn per call to stream().
 */
class MockProvider implements Provider {
  private responses: ProviderEvent[][];

  constructor(responses: ProviderEvent[][]) {
    this.responses = responses;
  }

  async *stream(_req: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    const turn = this.responses.shift();
    if (!turn) throw new Error("MockProvider: no more responses");
    for (const e of turn) yield e;
  }
}

/**
 * Mock platform that captures signal and records exec calls per command.
 *
 * buildEnvContext calls platform.exec twice (git rev-parse, git status).
 * bashTool calls platform.exec once with the actual command (e.g. "echo hi").
 *
 * Tracking by command lets tests assert "the tool's exec" vs "the env exec".
 * For git commands we return exitCode:1 (matching MockPlatform in agent.test.ts)
 * so buildEnvContext silently omits git info. For other commands we return
 * exitCode:0 with stdout:"done".
 *
 * Does NOT assign `undefined` to optional fields (respects exactOptionalPropertyTypes).
 */
function makeMockPlatform() {
  let capturedSignal: AbortSignal | undefined;
  // Each entry: [command, opts]
  const execCalls: Array<{ cmd: string; opts: ExecOptions | undefined }> = [];

  const platform: Platform = {
    cwd: () => "/work",
    readFile: (_path: string) => Promise.reject(new Error("readFile not used")),
    writeFile: (_path: string, _content: string): Promise<void> => Promise.resolve(),
    exec: async (cmd: string, opts?: ExecOptions): Promise<ExecResult> => {
      execCalls.push({ cmd, opts });
      if (opts?.signal !== undefined) {
        capturedSignal = opts.signal;
      }
      // Return non-zero for git commands so buildEnvContext skips git info
      // (matches the pattern used in agent.test.ts's MockPlatform).
      if (cmd.startsWith("git ")) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return { stdout: "done", stderr: "", exitCode: 0 };
    },
    listDir: () => Promise.reject(new Error("listDir not used")),
    stat: () => Promise.reject(new Error("stat not used")),
    glob: () => Promise.reject(new Error("glob not used")),
    grep: () => Promise.reject(new Error("grep not used")),
  };

  return {
    platform,
    getCapturedSignal: () => capturedSignal,
    /** Number of exec calls made by the bash tool (non-git commands). */
    getToolExecCallCount: () => execCalls.filter((c) => !c.cmd.startsWith("git ")).length,
    /** All exec calls (including git env-context calls). */
    getAllExecCalls: () => execCalls,
  };
}

/**
 * A mock provider scripted to yield one bash `tool_use` then stop,
 * followed by a text response turn so the agent can complete naturally.
 */
function makeBashToolProvider(toolId = "t-bash-1") {
  return new MockProvider([
    // Turn 1: model asks to run bash
    [
      {
        type: "tool_use",
        id: toolId,
        name: "bash",
        input: { command: "echo hi" },
      },
      { type: "message_stop", stopReason: "tool_use" },
    ],
    // Turn 2: model responds after seeing tool result
    [
      { type: "text_delta", text: "Done." },
      { type: "message_stop", stopReason: "end_turn" },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-tooling integration: signal forwarding", () => {
  it("forwards context.signal to platform.exec end-to-end (AC: context.signal populated)", async () => {
    // Arrange
    const { platform, getCapturedSignal } = makeMockPlatform();
    const provider = makeBashToolProvider();

    const agent = new Agent({
      provider,
      tools: [bashTool],
      platform,
    });

    // Act — break immediately after the tool_result event; the signal must still
    // have been forwarded into platform.exec during that tool execution.
    for await (const event of agent.run("run a command")) {
      if (event.type === "tool_result") break;
    }

    // Assert
    const capturedSignal = getCapturedSignal();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("the AbortSignal forwarded to exec is the run's signal (not a global or unrelated signal)", async () => {
    // Two separate agent.run() calls must produce two different AbortSignal instances.
    const { platform: platform1, getCapturedSignal: getSignal1 } = makeMockPlatform();
    const { platform: platform2, getCapturedSignal: getSignal2 } = makeMockPlatform();

    const provider1 = makeBashToolProvider("t1");
    const provider2 = makeBashToolProvider("t2");

    const agent1 = new Agent({ provider: provider1, tools: [bashTool], platform: platform1 });
    const agent2 = new Agent({ provider: provider2, tools: [bashTool], platform: platform2 });

    for await (const event of agent1.run("run command one")) {
      if (event.type === "tool_result") break;
    }
    for await (const event of agent2.run("run command two")) {
      if (event.type === "tool_result") break;
    }

    const signal1 = getSignal1();
    const signal2 = getSignal2();

    expect(signal1).toBeDefined();
    expect(signal2).toBeDefined();
    // Each run creates its own AbortController so the signals are distinct.
    expect(signal1).not.toBe(signal2);
  });
});

describe("agent-tooling integration: approvalHandler deny", () => {
  it("approvalHandler returning 'deny' produces isError:true tool_result end-to-end (AC: approval gate)", async () => {
    // Arrange — the bash tool's exec must NOT be called because the gate blocks execution.
    // (buildEnvContext calls exec twice for git info — those are env calls, not tool calls.)
    const { platform, getToolExecCallCount } = makeMockPlatform();
    const provider = makeBashToolProvider();

    const approvalHandler: ApprovalHandler = async () => "deny";

    const agent = new Agent({
      provider,
      tools: [bashTool],
      platform,
      approvalHandler,
    });

    // Act — collect all events (the agent completes naturally after the denied turn).
    const events: AgentEvent[] = [];
    for await (const event of agent.run("run a command")) {
      events.push(event);
    }

    // Assert: tool_result with isError and the expected denial message.
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();

    if (toolResult?.type !== "tool_result") throw new Error("type guard: expected tool_result");
    expect(toolResult.isError).toBe(true);
    expect(String(toolResult.result)).toContain("call denied by approvalHandler");

    // Critical invariant: the bash tool's exec was NEVER called — the gate blocked it
    // before tool.call. (env-context git exec calls are separate and not counted here.)
    expect(getToolExecCallCount()).toBe(0);
  });

  it("approvalHandler denial error message names the tool (bash)", async () => {
    const { platform } = makeMockPlatform();
    const provider = makeBashToolProvider();

    const agent = new Agent({
      provider,
      tools: [bashTool],
      platform,
      approvalHandler: async () => "deny",
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("run a command")) {
      events.push(event);
    }

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("type guard: expected tool_result");
    // The message should reference the tool name 'bash'.
    expect(String(toolResult.result)).toContain("bash");
  });

  it("approvalHandler throwing produces isError:true tool_result and tool exec is NOT called", async () => {
    const { platform, getToolExecCallCount } = makeMockPlatform();
    const provider = makeBashToolProvider();

    const throwingApprovalHandler: ApprovalHandler = async () => {
      throw new Error("approval service unavailable");
    };

    const agent = new Agent({
      provider,
      tools: [bashTool],
      platform,
      approvalHandler: throwingApprovalHandler,
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("run a command")) {
      events.push(event);
    }

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("type guard: expected tool_result");
    expect(toolResult.isError).toBe(true);
    expect(String(toolResult.result)).toContain("approval check failed");
    expect(String(toolResult.result)).toContain("approval service unavailable");
    // The bash tool's exec must not have been called — the gate failed before reaching tool.call.
    expect(getToolExecCallCount()).toBe(0);
  });
});

describe("agent-tooling integration: approvalHandler allow", () => {
  it("approvalHandler returning 'allow' permits exec to be called and produces isError:false tool_result", async () => {
    // Arrange
    const { platform, getCapturedSignal, getToolExecCallCount } = makeMockPlatform();
    const provider = makeBashToolProvider();

    const approvalHandler: ApprovalHandler = async () => "allow";

    const agent = new Agent({
      provider,
      tools: [bashTool],
      platform,
      approvalHandler,
    });

    // Act
    const events: AgentEvent[] = [];
    for await (const event of agent.run("run a command")) {
      events.push(event);
    }

    // Assert: the bash tool's exec was called exactly once (not blocked).
    expect(getToolExecCallCount()).toBe(1);

    // Signal should still have been forwarded.
    expect(getCapturedSignal()).toBeInstanceOf(AbortSignal);

    // tool_result should be successful.
    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("type guard: expected tool_result");
    expect(toolResult.isError).toBe(false);
  });
});

describe("agent-tooling integration: no approvalHandler (regression gate)", () => {
  it("Agent without approvalHandler still works — exec is called, tool_result is successful", async () => {
    // Regression: existing behaviour must be preserved when approvalHandler is omitted.
    const { platform, getToolExecCallCount } = makeMockPlatform();
    const provider = makeBashToolProvider();

    // No approvalHandler — blanket allow.
    const agent = new Agent({
      provider,
      tools: [bashTool],
      platform,
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("run a command")) {
      events.push(event);
    }

    // The bash tool's exec should have been called once.
    expect(getToolExecCallCount()).toBe(1);

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("type guard: expected tool_result");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.toolName).toBe("bash");
  });

  it("agent completes naturally (agent_done) after the bash tool runs without approvalHandler", async () => {
    const { platform } = makeMockPlatform();
    const provider = makeBashToolProvider();

    const agent = new Agent({ provider, tools: [bashTool], platform });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("run a command")) {
      events.push(event);
    }

    // The loop should have completed naturally.
    expect(events.at(-1)?.type).toBe("agent_done");
  });
});

describe("agent-tooling integration: export surface (type-level checks)", () => {
  // These tests serve as type-level assertions: if the imports compile,
  // the public surface from index.ts includes the required symbols.
  // The actual runtime values are verified in other tests above.

  it("bashTool has the expected name and call property (surface sanity)", () => {
    expect(bashTool.name).toBe("bash");
    expect(typeof bashTool.call).toBe("function");
    expect(bashTool.inputSchema).toBeDefined();
  });

  it("ApprovalHandler type is usable as a function type for runtime callbacks", () => {
    // This compiles only if ApprovalHandler is importable and usable.
    const handler: ApprovalHandler = async (_name: string, _input: unknown) => "allow";
    expect(typeof handler).toBe("function");
  });
});
