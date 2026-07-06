import OpenAI from "openai";
import type { Provider, ProviderRequest, ProviderEvent, Logger } from "../types/provider.js";
import { mapRequest, translateChunk, ToolCallAccumulator } from "./openai-mapper.js";
// withRetry is NOT imported here. The OpenAI SDK retries internally via maxRetries.

export type OpenAIProviderOptions = {
  apiKey: string;
  model: string;
  maxRetries?: number; // default: 3 (LOCKED — match Anthropic, not the SDK's native 2)
  baseURL?: string; // LOCKED — exposed; covers OpenAI-compatible endpoints
  maxTokens?: number; // default: 32000 (LOCKED — mirrors Anthropic)
  logger?: Logger;
};

export class OpenAIProvider implements Provider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly maxTokens: number;
  private readonly logger?: Logger;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAIProvider: OPENAI_API_KEY is required");
    }
    this.maxRetries = options.maxRetries ?? 3;
    this.maxTokens = options.maxTokens ?? 32000;
    // exactOptionalPropertyTypes: assign only when present so the optional field
    // is omitted rather than set to `undefined`.
    if (options.logger) this.logger = options.logger;
    this.model = options.model;
    // exactOptionalPropertyTypes: baseURL must be spread conditionally to avoid
    // passing `undefined` where the OpenAI SDK expects string | omitted.
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: this.maxRetries, // SDK owns retry — backoff+jitter on 429/5xx/connection
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const params = mapRequest(request, this.model, this.maxTokens);
    this.logger?.({ level: "info", event: "request_sent", request });

    const accumulator = new ToolCallAccumulator();

    // The SDK retries transient errors (429/5xx/connection) internally per maxRetries.
    // No withRetry wrapper — the SDK retry covers both stream construction and iteration.
    // Unlike Anthropic's sync `messages.stream()`, `chat.completions.create({ stream: true })`
    // returns a Promise<Stream<...>>, so it must be awaited before the for-await loop.
    // The mapper's local OpenAIChatCompletionParams is a faithful structural subset of the
    // SDK's ChatCompletionCreateParamsStreaming (which the mapper deliberately does not import
    // to stay SDK-runtime-free); cast at the call site, mirroring anthropic-mapper.ts:13,21.
    const rawStream = await this.client.chat.completions.create(
      { ...params, stream: true } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal },
    );

    for await (const chunk of rawStream) {
      for (const ev of translateChunk(chunk, accumulator)) yield ev;
    }
    // OpenAI has no terminal event — flush the synthesized message_stop (+ any
    // accumulated tool_use) after the iterator ends.
    for (const ev of accumulator.flush()) yield ev;
  }
}
