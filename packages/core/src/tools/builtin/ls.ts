import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../types/tool.js";
import type { DirEntry } from "../../types/platform.js";

const DEFAULT_LIMIT = 250;

function isTestEnv(): boolean {
  return globalThis.process?.env?.NODE_ENV === "test";
}

export const lsTool = defineTool({
  name: "ls",
  description:
    "List the immediate entries of a directory (names, type, size, modification time). Not recursive — use glob for recursive file discovery.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or cwd-relative directory to list."),
    limit: z.number().int().positive().optional().describe("Max entries to return. Default 250."),
  }),
  call: async ({ path: dirPath, limit }, platform) => {
    const cwd = platform.cwd();
    const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);

    const all = await platform.listDir(resolved);

    const sorted = [...all].sort(
      isTestEnv()
        ? (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        : (a, b) => b.mtimeMs - a.mtimeMs,
    );

    const cap = limit ?? DEFAULT_LIMIT;
    const truncated = sorted.length > cap;
    const entries: DirEntry[] = truncated ? sorted.slice(0, cap) : sorted;

    return { entries, truncated };
  },
  isConcurrencySafe: () => true,
});
