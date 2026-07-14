import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { Agent } from "../agent.js";
import { NodePlatform } from "../platform/node.js";
import { collectEvents } from "../utils/collect.js";
import type { ProviderEvent } from "../types/provider.js";

// Mock the Anthropic SDK so no network is touched and the streaming path runs to
// completion. vi.mock is hoisted above the imports below, so the top-level
// `import { AnthropicProvider }` picks up this stub.
const streamSpy = vi.fn();
let streamImpl: () => AsyncGenerator<unknown>;

async function* defaultStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: {} };
  yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
  yield { type: "message_stop" };
}

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        stream: (...args: unknown[]) => {
          streamSpy(...args);
          return streamImpl();
        },
      };
    },
  };
});

// Imported AFTER the mock declaration; Vitest hoists vi.mock so this binds to the stub.
import { AnthropicProvider } from "../providers/anthropic.js";

/** Drain an async generator to completion, collecting yielded events. */
async function drain(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("AnthropicProvider", () => {
  beforeEach(() => {
    streamSpy.mockClear();
    streamImpl = defaultStream;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces zero console output when no logger is configured (7.14)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const provider = new AnthropicProvider({ apiKey: "k", model: "m" });
    const events = await drain(
      provider.stream({ systemPrompt: "", messages: [], tools: [] }),
    );

    // Stream ran to completion and the provider boundary emitted a structured reason.
    expect(events).toEqual([
      { type: "message_stop", stopReason: { kind: "end_turn", raw: "end_turn" } },
    ]);

    // The real 7.14 check: nothing is emitted to the console without a logger.
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("preserves an unknown native reason through the provider integration", async () => {
    streamImpl = async function* () {
      yield { type: "message_delta", delta: { stop_reason: "future_reason" } };
      yield { type: "message_stop" };
    };

    const provider = new AnthropicProvider({ apiKey: "k", model: "m" });
    await expect(drain(provider.stream({ systemPrompt: "", messages: [], tools: [] }))).resolves.toEqual([
      { type: "message_stop", stopReason: { kind: "other", raw: "future_reason" } },
    ]);
  });

  it("flows a provider-native unknown reason through Agent to the structured Terminal (SR-13)", async () => {
    streamImpl = async function* () {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
      yield { type: "message_delta", delta: { stop_reason: "future_reason" } };
      yield { type: "message_stop" };
    };

    const provider = new AnthropicProvider({ apiKey: "k", model: "m" });
    const { events, terminal } = await collectEvents(
      new Agent({ provider, tools: [], platform: new NodePlatform() }).run("test"),
    );

    expect(events).toContainEqual({ type: "text_delta", text: "partial" });
    if (terminal.reason !== "agent_done") throw new Error("expected successful terminal");
    expect(terminal.stopReason).toEqual({ kind: "other", raw: "future_reason" });
  });

  it("fires the logger with request_sent when a logger is provided", async () => {
    const logger = vi.fn();
    const provider = new AnthropicProvider({ apiKey: "k", model: "m", logger });

    await drain(provider.stream({ systemPrompt: "", messages: [], tools: [] }));

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ event: "request_sent" }),
    );
  });

  it("passes the AbortSignal through to messages.stream as the second argument", async () => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "m" });
    const controller = new AbortController();

    await drain(
      provider.stream({ systemPrompt: "", messages: [], tools: [] }, controller.signal),
    );

    expect(streamSpy).toHaveBeenCalledTimes(1);
    const firstCall = streamSpy.mock.calls[0];
    if (!firstCall) throw new Error("unreachable");
    const secondArg = firstCall[1] as { signal?: AbortSignal };
    expect(secondArg).toMatchObject({ signal: controller.signal });
  });

  it("throws when apiKey is empty", () => {
    expect(() => new AnthropicProvider({ apiKey: "", model: "m" })).toThrow(
      "AnthropicProvider: ANTHROPIC_API_KEY is required",
    );
  });

  it("throws when apiKey is missing (undefined)", () => {
    expect(
      () =>
        new AnthropicProvider({
          apiKey: undefined as unknown as string,
          model: "m",
        }),
    ).toThrow("AnthropicProvider: ANTHROPIC_API_KEY is required");
  });
});
