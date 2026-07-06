import { describe, it, expect } from "vitest";
import { z } from "zod";

import { Agent } from "../agent.js";
import { defineTool } from "../types/tool.js";
import { readFileTool } from "../tools/builtin/readFile.js";
import { collectEvents } from "../utils/collect.js";
import { EMPTY_USAGE } from "../types/usage.js";
import type { Provider, ProviderEvent, ProviderRequest } from "../types/provider.js";
import type { Platform, ExecResult } from "../types/platform.js";
import type { AgentEvent, Terminal } from "../types/events.js";
import type { Message, ContentBlock } from "../types/messages.js";

/**
 * Request-capturing provider. Replays one scripted turn per call to stream() and
 * deep-copies the messages array on each call so that later mutation of the
 * loop's working-messages array cannot retroactively change what we recorded.
 */
class MockProvider implements Provider {
  private responses: ProviderEvent[][];
  readonly requests: ProviderRequest[] = [];

  constructor(responses: ProviderEvent[][]) {
    this.responses = responses;
  }

  async *stream(req: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    this.requests.push({
      ...req,
      // Deep-copy messages (and their content blocks) so a snapshot is frozen at
      // the moment of the call.
      messages: req.messages.map((m) => ({
        ...m,
        content: Array.isArray(m.content)
          ? m.content.map((b) => ({ ...b }))
          : m.content,
      })),
    });
    const turn = this.responses.shift();
    if (!turn) throw new Error("MockProvider: no more responses");
    for (const e of turn) yield e;
  }
}

/** Provider whose stream() throws synchronously on invocation. */
class ThrowingProvider implements Provider {
  async *stream(): AsyncGenerator<ProviderEvent> {
    throw new Error("network down");
  }
}

/**
 * Provider that captures the AbortSignal, yields one text_delta, then blocks
 * until the signal aborts. Deterministic: the awaited promise resolves only when
 * abort fires, so there is no timer and the test cannot hang once the consumer
 * breaks (which triggers the agent's finally → abortCtrl.abort()).
 */
class AbortCapturingProvider implements Provider {
  capturedSignal: AbortSignal | undefined;

  async *stream(_req: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    this.capturedSignal = signal;
    yield { type: "text_delta", text: "first" };
    await new Promise<void>((res) => {
      signal!.addEventListener("abort", () => res(), { once: true });
    });
    // Never reached in the abandonment test, but keeps the generator well-formed.
  }
}

/**
 * Configurable platform. cwd() returns the supplied sentinel; readFile returns
 * supplied file contents; exec returns a non-zero exit so buildEnvContext omits
 * the git lines (keeping the env block deterministic across machines).
 */
class MockPlatform implements Platform {
  constructor(
    private readonly opts: { cwd?: string; fileContent?: string } = {},
  ) {}

  cwd(): string {
    return this.opts.cwd ?? "/work";
  }
  readFile(_path: string): Promise<string> {
    if (this.opts.fileContent === undefined) {
      return Promise.reject(new Error("readFile not stubbed"));
    }
    return Promise.resolve(this.opts.fileContent);
  }
  writeFile(): Promise<void> {
    return Promise.resolve();
  }
  exec(): Promise<ExecResult> {
    // Non-zero exit → buildEnvContext skips the Git branch/status lines.
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  }
}

describe("Agent.run", () => {
  it("streams text and completes naturally (7.1)", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hello" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    const { events, terminal } = await collectEvents(agent.run("test"));

    expect(events).toContainEqual({ type: "text_delta", text: "hello" });

    const done = events.find((e) => e.type === "agent_done");
    if (done?.type !== "agent_done") throw new Error("expected agent_done event");
    // The terminal event is the last one yielded.
    expect(events.at(-1)?.type).toBe("agent_done");

    expect(terminal.reason).toBe("agent_done");
  });

  it("yields agent_error when the provider stream throws (7.6)", async () => {
    const agent = new Agent({
      provider: new ThrowingProvider(),
      tools: [],
      platform: new MockPlatform(),
    });

    const { events, terminal } = await collectEvents(agent.run("test"));

    const errorEvent = events.find((e) => e.type === "agent_error");
    if (errorEvent?.type !== "agent_error") throw new Error("expected agent_error event");
    expect(errorEvent.error).toBeInstanceOf(Error);
    expect(errorEvent.error.message).toBe("network down");

    expect(terminal.reason).toBe("agent_error");
    if (terminal.reason !== "agent_error") throw new Error("unreachable");
    expect(terminal.error.message).toBe("network down");
  });

  it("threads prior-run history into the next run's request (7.9)", async () => {
    // Run 1: assistant replies with text, completes.
    const provider1 = new MockProvider([
      [
        { type: "text_delta", text: "the capital is Paris" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent1 = new Agent({ provider: provider1, tools: [], platform: new MockPlatform() });

    const { terminal: terminal1 } = await collectEvents(agent1.run("What is the capital of France?"));
    expect(terminal1.reason).toBe("agent_done");
    const history: Message[] = terminal1.messages;

    // History must carry the assistant turn from run 1.
    const assistantTurn = history.find((m) => m.role === "assistant");
    if (!assistantTurn) throw new Error("run 1 history had no assistant message");

    // Run 2: thread the history back in.
    const provider2 = new MockProvider([
      [
        { type: "text_delta", text: "It has ~2.1M residents." },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent2 = new Agent({ provider: provider2, tools: [], platform: new MockPlatform() });

    const { terminal: terminal2 } = await collectEvents(
      agent2.run("How many people live there?", { messages: history }),
    );
    expect(terminal2.reason).toBe("agent_done");

    // The provider for run 2 must have received the prior assistant message.
    expect(provider2.requests).toHaveLength(1);
    const run2Request = provider2.requests[0];
    if (!run2Request) throw new Error("provider2 received no request");

    const roles = run2Request.messages.map((m) => m.role);
    // Expected threading: [user(run1), assistant(run1), user(run2)].
    expect(roles).toEqual(["user", "assistant", "user"]);

    const threadedAssistant = run2Request.messages.find((m) => m.role === "assistant");
    if (!threadedAssistant) throw new Error("run 2 request did not include prior assistant message");
    const blocks = threadedAssistant.content as ContentBlock[];
    const text = blocks.find((b) => b.type === "text");
    if (text?.type !== "text") throw new Error("assistant message had no text block");
    expect(text.text).toBe("the capital is Paris");

    // The freshly-appended user prompt for run 2 is last.
    const lastMsg = run2Request.messages.at(-1);
    expect(lastMsg?.role).toBe("user");
    expect(lastMsg?.content).toBe("How many people live there?");
  });

  it("injects the env context block into the system prompt (7.13)", async () => {
    const provider = new MockProvider([
      [{ type: "message_stop", stopReason: "end_turn" }],
    ]);
    const agent = new Agent({
      provider,
      tools: [],
      platform: new MockPlatform({ cwd: "/test/cwd" }),
    });

    await collectEvents(agent.run("hi"));

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0];
    if (!req) throw new Error("provider received no request");
    expect(req.systemPrompt).toContain("Working directory: /test/cwd");
  });

  it("appends a custom systemPrompt after the env block (7.13)", async () => {
    const provider = new MockProvider([
      [{ type: "message_stop", stopReason: "end_turn" }],
    ]);
    const agent = new Agent({
      provider,
      tools: [],
      platform: new MockPlatform({ cwd: "/test/cwd" }),
      systemPrompt: "CUSTOM",
    });

    await collectEvents(agent.run("hi"));

    const req = provider.requests[0];
    if (!req) throw new Error("provider received no request");

    // Env block first, then a blank line, then the custom prompt.
    expect(req.systemPrompt).toContain("Working directory: /test/cwd");
    expect(req.systemPrompt.endsWith("\n\nCUSTOM")).toBe(true);
    // The env block precedes the custom text.
    const envIdx = req.systemPrompt.indexOf("Working directory: /test/cwd");
    const customIdx = req.systemPrompt.indexOf("CUSTOM");
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeGreaterThan(envIdx);
  });

  it("aborts the in-flight provider stream when the consumer abandons the loop (7.17)", async () => {
    const provider = new AbortCapturingProvider();
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    let sawFirst = false;
    for await (const event of agent.run("test")) {
      if (event.type === "text_delta") {
        sawFirst = true;
        break; // abandon — triggers generator.return() → finally → abortCtrl.abort()
      }
    }

    expect(sawFirst).toBe(true);
    expect(provider.capturedSignal).toBeDefined();
    // The agent's finally fired on the early break, aborting the captured signal.
    expect(provider.capturedSignal?.aborted).toBe(true);
  });

  it("runs the built-in readFileTool end-to-end and returns the file contents (built-in tools)", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "/some/file.txt" } },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "read it" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent = new Agent({
      provider,
      tools: [readFileTool],
      platform: new MockPlatform({ fileContent: "FILE-CONTENTS" }),
    });

    const { events, terminal } = await collectEvents(agent.run("read the file"));

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result event");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.toolName).toBe("read_file");
    expect(toolResult.result).toEqual({ content: "FILE-CONTENTS" });

    // The serialized content threaded back into turn 2 must carry the file text.
    const turn2 = provider.requests[1];
    if (!turn2) throw new Error("provider did not receive a second request");
    const last = turn2.messages.at(-1);
    expect(last?.role).toBe("user");
    const blocks = last?.content as ContentBlock[];
    const trBlock = blocks.find((b) => b.type === "tool_result");
    if (trBlock?.type !== "tool_result") throw new Error("expected tool_result block in turn 2");
    expect(trBlock.is_error).toBe(false);
    expect(trBlock.content).toContain("FILE-CONTENTS");

    expect(terminal.reason).toBe("agent_done");
  });

  it("converts an unserializable tool result into a recoverable tool error (serialize-catch §4.2)", async () => {
    // This tool returns a value containing a BigInt — JSON.stringify throws on it,
    // so the loop's serialize-catch must turn it into an isError tool_result rather
    // than letting the exception escape to the caller.
    const badTool = defineTool({
      name: "bad_tool",
      description: "returns an unserializable value",
      inputSchema: z.object({}).passthrough(),
      call: async () => ({ big: 10n }),
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "b1", name: "bad_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "recovered" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent = new Agent({ provider, tools: [badTool], platform: new MockPlatform() });

    // Must not throw — the serialize-catch wrapper keeps the loop alive.
    const { events, terminal } = await collectEvents(agent.run("call bad tool"));

    // The serialized tool_result bundled into turn 2 must be an error carrying the
    // "could not serialize result" message.
    const turn2 = provider.requests[1];
    if (!turn2) throw new Error("provider did not receive a second request");
    const last = turn2.messages.at(-1);
    expect(last?.role).toBe("user");
    const blocks = last?.content as ContentBlock[];
    const trBlock = blocks.find((b) => b.type === "tool_result");
    if (trBlock?.type !== "tool_result") throw new Error("expected tool_result block in turn 2");
    expect(trBlock.is_error).toBe(true);
    expect(trBlock.content).toContain("could not serialize result");

    // The loop recovered and reached natural completion.
    expect(terminal.reason).toBe("agent_done");
    expect(events.at(-1)?.type).toBe("agent_done");
  });
});

describe("Agent.run — AbortSignal", () => {
  /**
   * (a) Pre-aborted signal → immediate agent_error, provider.stream never called.
   *
   * Verifies that when an already-aborted signal is passed the pre-flight guard
   * fires: the FIRST and ONLY yielded event is agent_error; the Terminal reason is
   * "agent_error"; provider.stream was NEVER invoked (buildEnvContext / agentLoop
   * were skipped entirely); and the usage on the error event is EMPTY_USAGE.
   */
  it("pre-aborted signal → only event is agent_error and provider.stream is not called (§3.4)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const provider = new MockProvider([
      [
        { type: "text_delta", text: "should not be reached" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    const { events, terminal } = await collectEvents(agent.run("test", { signal: ctrl.signal }));

    // The FIRST and ONLY event is agent_error.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("agent_error");

    // Terminal carries the error reason.
    expect(terminal.reason).toBe("agent_error");

    // Provider stream was never invoked — buildEnvContext / agentLoop were skipped.
    expect(provider.requests).toHaveLength(0);

    // The agent_error event carries EMPTY_USAGE (no tokens consumed).
    if (events[0]?.type !== "agent_error") throw new Error("expected agent_error event");
    expect(events[0].usage).toEqual(EMPTY_USAGE);

    // Terminal usage is also EMPTY_USAGE.
    if (terminal.reason !== "agent_error") throw new Error("unreachable");
    expect(terminal.usage).toEqual(EMPTY_USAGE);
  });

  /**
   * (a) Pre-aborted signal — abort reason forwarded as error message.
   *
   * When abort() is called with an Error argument, the error message is preserved
   * rather than falling back to the generic "Run aborted before start" text.
   */
  it("pre-aborted signal with Error reason → error message is preserved (§3.4)", async () => {
    const ctrl = new AbortController();
    const reason = new Error("caller cancelled");
    ctrl.abort(reason);

    const provider = new MockProvider([]);
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    const { events, terminal } = await collectEvents(agent.run("test", { signal: ctrl.signal }));

    expect(events).toHaveLength(1);
    if (events[0]?.type !== "agent_error") throw new Error("expected agent_error event");
    expect(events[0].error.message).toBe("caller cancelled");
    expect(terminal.reason).toBe("agent_error");
  });

  /**
   * (a) Pre-aborted signal — non-Error reason falls back to generic message.
   *
   * When abort() is called with a non-Error reason (string, undefined, etc.), the
   * fallback message "Run aborted before start" is used.
   */
  it("pre-aborted signal with non-Error reason → fallback error message (§3.4)", async () => {
    const ctrl = new AbortController();
    ctrl.abort("some string reason");

    const provider = new MockProvider([]);
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    const { events, terminal } = await collectEvents(agent.run("test", { signal: ctrl.signal }));

    expect(events).toHaveLength(1);
    if (events[0]?.type !== "agent_error") throw new Error("expected agent_error event");
    expect(events[0].error.message).toBe("Run aborted before start");
    expect(terminal.reason).toBe("agent_error");
  });

  /**
   * (b) No signal → run completes normally.
   *
   * Sanity check that omitting the signal entirely does not regress normal
   * completion. terminal.reason must be "agent_done".
   */
  it("no signal → run completes normally with agent_done (§3.1)", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hello" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    // Deliberately call with no second argument — exercising the "no signal" path.
    const { terminal } = await collectEvents(agent.run("test"));

    expect(terminal.reason).toBe("agent_done");
    // Provider was called normally.
    expect(provider.requests).toHaveLength(1);
  });

  /**
   * (b) Empty options object (no signal property) → run completes normally.
   *
   * Verifies exactOptionalPropertyTypes compliance: passing {} must not cause a
   * compile error or runtime misbehaviour.
   */
  it("empty options object → run completes normally with agent_done (exactOptionalPropertyTypes)", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hi" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    // Pass an explicit empty options object — must compile and run without error.
    const { terminal } = await collectEvents(agent.run("test", {}));

    expect(terminal.reason).toBe("agent_done");
  });

  /**
   * (c) Mid-run abort → terminal reason is agent_error.
   *
   * Uses a provider that yields one text_delta then throws when the signal is
   * aborted — mirroring real provider behaviour (Anthropic SDK, fetch, etc.).
   * The key: the provider checks `signal.aborted` synchronously at the start of
   * its blocking Promise constructor. This means that even if abort fires in the
   * for-await consumer's body (before the outer generator's next .next() call is
   * processed), the provider correctly throws on its next resumption.
   *
   * Abort is issued from outside (external ctrl) after observing the first
   * text_delta. The agentLoop's catch block converts the thrown error into
   * agent_error, giving terminal.reason === "agent_error".
   *
   * Note: usage will be EMPTY_USAGE because this provider does not emit a
   * usage-bearing message_stop — usage wiring comes in task-04.
   */
  it("mid-run abort → terminal reason is agent_error with abort-related error (§3.1)", async () => {
    // A provider that yields one text_delta, then throws when the signal aborts —
    // modelling how real streaming providers (fetch, Anthropic SDK) behave.
    //
    // Critical: the `signal.aborted` pre-check inside the Promise constructor runs
    // synchronously when the generator is resumed. If abort already fired (e.g.
    // in the preceding for-await body), the Promise rejects immediately without
    // needing microtask scheduling, so the outer iterator.next() call sees the
    // throw in the same tick it processes the abort.
    class AbortThrowingProvider implements Provider {
      async *stream(_req: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
        yield { type: "text_delta", text: "partial" };
        await new Promise<never>((_resolve, reject) => {
          // Pre-check: abort may have fired synchronously before this resumption.
          if (signal!.aborted) {
            reject(new DOMException("signal aborted", "AbortError"));
            return;
          }
          const onAbort = (): void => {
            signal!.removeEventListener("abort", onAbort);
            reject(new DOMException("signal aborted", "AbortError"));
          };
          signal!.addEventListener("abort", onAbort);
        });
      }
    }

    const ctrl = new AbortController();
    const provider = new AbortThrowingProvider();
    const agent = new Agent({ provider, tools: [], platform: new MockPlatform() });

    // Drive the iterator manually. After consuming text_delta, call ctrl.abort()
    // synchronously, then call iterator.next() again. Because the provider's
    // Promise constructor checks signal.aborted synchronously, it immediately
    // rejects, causing the agentLoop's catch to yield agent_error.
    const collectedEvents: AgentEvent[] = [];
    let terminal!: Terminal;
    const iterator = agent.run("test", { signal: ctrl.signal })[Symbol.asyncIterator]();

    while (true) {
      const result = await iterator.next();
      if (result.done) {
        terminal = result.value;
        break;
      }
      collectedEvents.push(result.value);
      if (result.value.type === "text_delta") {
        ctrl.abort();
      }
    }

    // The run must terminate with an error reason.
    expect(terminal.reason).toBe("agent_error");

    // The terminal carries a real Error (the thrown DOMException/AbortError).
    if (terminal.reason !== "agent_error") throw new Error("unreachable");
    expect(terminal.error).toBeInstanceOf(Error);
  });
});
