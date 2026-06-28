import type { AgentEvent, Terminal } from "../types/events.js";

/**
 * Collect all text_delta events into a single string.
 * Drives the generator to completion. Discards the Terminal return value.
 * Use for simple one-shot non-streaming callers.
 */
export async function collectText(
  gen: AsyncGenerator<AgentEvent, Terminal>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const event of gen) {
    if (event.type === "text_delta") chunks.push(event.text);
  }
  return chunks.join("");
}

/**
 * Collect all events into an array. Also returns the Terminal.
 * Use in tests to assert exact event sequences.
 */
export async function collectEvents(
  gen: AsyncGenerator<AgentEvent, Terminal>,
): Promise<{ events: AgentEvent[]; terminal: Terminal }> {
  const events: AgentEvent[] = [];
  let terminal!: Terminal;
  let result: IteratorResult<AgentEvent, Terminal>;

  const iterator = gen[Symbol.asyncIterator]();
  while (true) {
    result = await iterator.next();
    if (result.done) {
      terminal = result.value;
      break;
    }
    events.push(result.value);
  }

  return { events, terminal };
}
