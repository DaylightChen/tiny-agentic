import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderRequest, ProviderEvent, Logger } from "../types/provider.js";
import { mapRequest, translateStreamEvent, InputAccumulator } from "./anthropic-mapper.js";
// withRetry is NOT imported here. The Anthropic SDK retries internally via maxRetries.

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  maxRetries?: number; // default: 3; delegated to the SDK's built-in retry
  baseURL?: string;
  maxTokens?: number; // default: 32000
  logger?: Logger;
};

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly maxTokens: number;
  private readonly logger?: Logger;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error("AnthropicProvider: ANTHROPIC_API_KEY is required");
    }
    this.maxRetries = options.maxRetries ?? 3;
    this.maxTokens = options.maxTokens ?? 32000;
    // exactOptionalPropertyTypes: assign only when present so the optional field
    // is omitted rather than set to `undefined`.
    if (options.logger) this.logger = options.logger;
    this.model = options.model;
    // exactOptionalPropertyTypes: baseURL must be spread conditionally to avoid
    // passing `undefined` where the Anthropic SDK expects string | omitted.
    this.client = new Anthropic({
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

    const accumulator = new InputAccumulator();

    // The SDK retries transient errors (429/5xx/connection) internally per maxRetries.
    // No withRetry wrapper — wrapping only stream construction would leave iteration
    // errors unhandled; SDK retry covers both.
    const rawStream = this.client.messages.stream(params, { signal });

    for await (const event of rawStream) {
      for (const providerEvent of translateStreamEvent(event, accumulator)) {
        yield providerEvent;
      }
    }
  }
}
