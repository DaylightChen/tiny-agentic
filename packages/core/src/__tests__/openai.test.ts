import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import type { ProviderEvent, ProviderRequest } from "../types/provider.js";

// Mock the OpenAI SDK so no network is touched and the streaming path runs to
// completion. vi.mock is hoisted above the imports below, so the top-level
// `import { OpenAIProvider }` picks up this stub.
//
// - `ctorSpy` captures the options object passed to `new OpenAI({...})` so we can
//   assert maxRetries default/override and the conditional baseURL spread.
// - `createSpy` captures the args to `chat.completions.create(params, {signal})`
//   so we can assert signal passthrough.
// - `streamImpl` is a swappable factory returning the async-iterable of chunks a
//   given test wants to drive through translateChunk; defaults to a text-only
//   turn. `create` is `async` because the provider `await`s it.
const ctorSpy = vi.fn();
const createSpy = vi.fn();

type Chunk = unknown;
let streamImpl: () => AsyncGenerator<Chunk>;

async function* defaultStream(): AsyncGenerator<Chunk> {
  yield { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
  yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

vi.mock("openai", () => {
  return {
    default: class {
      constructor(options: unknown) {
        ctorSpy(options);
      }
      chat = {
        completions: {
          create: async (...args: unknown[]) => {
            createSpy(...args);
            return streamImpl();
          },
        },
      };
    },
  };
});

// Imported AFTER the mock declaration; Vitest hoists vi.mock so this binds to the stub.
import { OpenAIProvider } from "../providers/openai.js";

/** Drain an async generator to completion, collecting yielded events. */
async function drain(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const emptyRequest: ProviderRequest = { systemPrompt: "", messages: [], tools: [] };

describe("OpenAIProvider", () => {
  beforeEach(() => {
    ctorSpy.mockClear();
    createSpy.mockClear();
    streamImpl = defaultStream;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- 7.14 parity: silent by default ---------------------------------------

  it("produces zero console output when no logger is configured (7.14)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    const events = await drain(provider.stream({ ...emptyRequest }));

    // Stream ran to completion through the trailing accumulator.flush().
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "message_stop", stopReason: { kind: "end_turn", raw: "stop" } },
    ]);

    // The real 7.14 check: nothing is emitted to the console without a logger.
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fires the logger with request_sent when a logger is provided", async () => {
    const logger = vi.fn();
    const provider = new OpenAIProvider({ apiKey: "k", model: "m", logger });

    await drain(provider.stream({ ...emptyRequest }));

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ event: "request_sent" }),
    );
  });

  // --- AbortSignal passthrough ----------------------------------------------

  it("passes the AbortSignal through to create as the second argument", async () => {
    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    const controller = new AbortController();

    await drain(provider.stream({ ...emptyRequest }, controller.signal));

    expect(createSpy).toHaveBeenCalledTimes(1);
    const firstCall = createSpy.mock.calls[0];
    if (!firstCall) throw new Error("unreachable");
    const secondArg = firstCall[1] as { signal?: AbortSignal };
    expect(secondArg).toMatchObject({ signal: controller.signal });
  });

  // --- maxRetries default + override ----------------------------------------

  it("passes maxRetries default of 3 to new OpenAI when none is given", () => {
    new OpenAIProvider({ apiKey: "k", model: "m" });

    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const opts = ctorSpy.mock.calls[0]?.[0] as { maxRetries?: number };
    expect(opts.maxRetries).toBe(3);
  });

  it("passes an overridden maxRetries to new OpenAI", () => {
    new OpenAIProvider({ apiKey: "k", model: "m", maxRetries: 7 });

    const opts = ctorSpy.mock.calls[0]?.[0] as { maxRetries?: number };
    expect(opts.maxRetries).toBe(7);
  });

  // --- baseURL conditional spread -------------------------------------------

  it("threads baseURL to new OpenAI when provided", () => {
    new OpenAIProvider({ apiKey: "k", model: "m", baseURL: "https://example.test/v1" });

    const opts = ctorSpy.mock.calls[0]?.[0] as { baseURL?: string };
    expect(opts.baseURL).toBe("https://example.test/v1");
  });

  it("omits the baseURL key entirely when not provided (not baseURL: undefined)", () => {
    new OpenAIProvider({ apiKey: "k", model: "m" });

    const opts = ctorSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("baseURL" in opts).toBe(false);
  });

  // --- constructor validation -----------------------------------------------

  it("throws when apiKey is empty", () => {
    expect(() => new OpenAIProvider({ apiKey: "", model: "m" })).toThrow(
      "OpenAIProvider: OPENAI_API_KEY is required",
    );
  });

  it("throws when apiKey is missing (undefined)", () => {
    expect(
      () =>
        new OpenAIProvider({
          apiKey: undefined as unknown as string,
          model: "m",
        }),
    ).toThrow("OpenAIProvider: OPENAI_API_KEY is required");
  });

  // --- end-to-end equivalence (mock SDK), four scenarios --------------------

  it("yields text_delta(s) then exactly one message_stop for a text-only turn", async () => {
    streamImpl = async function* () {
      yield { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    };

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    const events = await drain(provider.stream({ ...emptyRequest }));

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "message_stop", stopReason: { kind: "end_turn", raw: "stop" } },
    ]);
  });

  it("infers a structured refusal reason without emitting refusal text", async () => {
    streamImpl = async function* () {
      yield { choices: [{ index: 0, delta: { refusal: "policy" }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    };

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    await expect(drain(provider.stream({ ...emptyRequest }))).resolves.toEqual([
      { type: "message_stop", stopReason: { kind: "refusal", raw: "stop" } },
    ]);
  });

  it("yields a single tool_use then message_stop for one tool call", async () => {
    streamImpl = async function* () {
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] },
            finish_reason: null,
          },
        ],
      };
      yield { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    };

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    const events = await drain(provider.stream({ ...emptyRequest }));

    expect(events).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
      { type: "message_stop", stopReason: { kind: "tool_use", raw: "tool_calls" } },
    ]);
  });

  it("yields two tool_use events in ascending index then message_stop for concurrent tool calls", async () => {
    streamImpl = async function* () {
      // Interleaved deltas for two concurrent tool calls (indices 0 and 1).
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "alpha", arguments: '{"x":' } },
                { index: 1, id: "call_b", function: { name: "beta", arguments: '{"y":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "1}" } },
                { index: 1, function: { arguments: "2}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    };

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    const events = await drain(provider.stream({ ...emptyRequest }));

    expect(events).toEqual([
      { type: "tool_use", id: "call_a", name: "alpha", input: { x: 1 } },
      { type: "tool_use", id: "call_b", name: "beta", input: { y: 2 } },
      { type: "message_stop", stopReason: { kind: "tool_use", raw: "tool_calls" } },
    ]);
  });

  it("flags malformed tool arguments with inputParseError and input {} then message_stop", async () => {
    streamImpl = async function* () {
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_x", function: { name: "broken", arguments: "{not json" } },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    };

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    const events = await drain(provider.stream({ ...emptyRequest }));

    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call_x",
        name: "broken",
        input: {},
        inputParseError: true,
      },
      { type: "message_stop", stopReason: { kind: "tool_use", raw: "tool_calls" } },
    ]);
  });

  // --- error propagation -----------------------------------------------------

  it("propagates an error thrown while constructing the stream (create rejects)", async () => {
    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
    createSpy.mockImplementationOnce(() => {
      throw new Error("boom-create");
    });

    await expect(drain(provider.stream({ ...emptyRequest }))).rejects.toThrow(
      "boom-create",
    );
  });

  it("propagates an error thrown during stream iteration (iterator throws)", async () => {
    streamImpl = async function* () {
      yield { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] };
      throw new Error("boom-iterate");
    };

    const provider = new OpenAIProvider({ apiKey: "k", model: "m" });

    await expect(drain(provider.stream({ ...emptyRequest }))).rejects.toThrow(
      "boom-iterate",
    );
  });
});
