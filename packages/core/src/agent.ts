import type { Provider } from "./types/provider.js";
import type { ApprovalHandler, Tool } from "./types/tool.js";
import type { Platform } from "./types/platform.js";
import type { AgentEvent, Terminal } from "./types/events.js";
import type { Message } from "./types/messages.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildEnvContext } from "./env/context.js";
import { agentLoop } from "./loop/loop.js";
import { EMPTY_USAGE } from "./types/usage.js";

export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  platform: Platform;
  systemPrompt?: string;
  maxTurns?: number; // default: 25
  approvalHandler?: ApprovalHandler;
};

export type RunOptions = {
  messages?: Message[];
  signal?: AbortSignal;
  /**
   * @internal Current sub-agent recursion depth (0 at the top level). Threaded
   * by the built-in `task` tool, which passes `depth + 1` when it drives a
   * child so `createTaskTool`'s `maxDepth` backstop can bound nested spawning.
   * Consumers running a top-level agent normally omit this (defaults to 0).
   */
  depth?: number;
};

export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private readonly platform: Platform;
  private readonly systemPrompt: string | undefined;
  private readonly maxTurns: number;
  private readonly approvalHandler: ApprovalHandler | undefined;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.platform = options.platform;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 25;
    this.approvalHandler = options.approvalHandler;
  }

  async *run(prompt: string, options: RunOptions = {}): AsyncGenerator<AgentEvent, Terminal> {
    const abortCtrl = new AbortController();
    const signal = options.signal !== undefined
      ? AbortSignal.any([options.signal, abortCtrl.signal])
      : abortCtrl.signal;
    try {
      if (signal.aborted) {
        const error = new Error(
          signal.reason instanceof Error
            ? signal.reason.message
            : "Run aborted before start"
        );
        const event = { type: "agent_error" as const, error, messages: options.messages ?? [], usage: EMPTY_USAGE };
        yield event;
        return { reason: "agent_error", error, messages: options.messages ?? [], usage: EMPTY_USAGE };
      }

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
        signal,
        depth: options.depth ?? 0,
        ...(this.approvalHandler !== undefined ? { approvalHandler: this.approvalHandler } : {}),
      });
    } finally {
      // If the consumer breaks out of the for-await loop, JS invokes the
      // generator's .return(), which runs this finally and aborts this run's
      // own controller — tearing down the in-flight provider stream at the next
      // suspension point. NOTE: while a tool.call is awaited (e.g. the `task`
      // tool driving a child), the parent generator has no yield point, so a
      // `break` cannot interrupt that call — it resolves first, and only then
      // does this abort fire. To cancel an in-flight sub-agent promptly, abort
      // the run `signal` you passed in; that cascades into the child at once.
      abortCtrl.abort();
    }
  }
}
