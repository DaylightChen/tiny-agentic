import type { Provider } from "./types/provider.js";
import type { Tool } from "./types/tool.js";
import type { Platform } from "./types/platform.js";
import type { AgentEvent, Terminal } from "./types/events.js";
import type { Message } from "./types/messages.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildEnvContext } from "./env/context.js";
import { agentLoop } from "./loop/loop.js";

export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  platform: Platform;
  systemPrompt?: string;
  maxTurns?: number; // default: 25
};

export type RunOptions = {
  messages?: Message[];
};

export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private readonly platform: Platform;
  private readonly systemPrompt: string | undefined;
  private readonly maxTurns: number;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.platform = options.platform;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 25;
  }

  async *run(prompt: string, options: RunOptions = {}): AsyncGenerator<AgentEvent, Terminal> {
    const abortCtrl = new AbortController();
    try {
      const registry = new ToolRegistry(this.tools);
      const workingMessages: Message[] = [
        ...(options.messages ?? []),
        { role: "user", content: prompt },
      ];
      const envCtx = await buildEnvContext(this.platform);
      const systemPrompt = this.systemPrompt ? `${envCtx}\n\n${this.systemPrompt}` : envCtx;

      return yield* agentLoop({
        provider: this.provider,
        registry,
        platform: this.platform,
        messages: workingMessages,
        systemPrompt,
        maxTurns: this.maxTurns,
        signal: abortCtrl.signal,
      });
    } finally {
      // If the consumer breaks out of the for-await loop, JS invokes the
      // generator's .return() which runs this finally, aborting the in-flight
      // provider stream.
      abortCtrl.abort();
    }
  }
}
