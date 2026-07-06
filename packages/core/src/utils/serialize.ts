/**
 * Serialize a tool call result to a string for inclusion in a tool_result message.
 * If the value is already a string, returns it as-is.
 * Otherwise JSON.stringify. Throws if serialization fails — caller should catch.
 */
export function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}
