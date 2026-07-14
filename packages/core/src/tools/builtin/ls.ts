import { z } from "zod";
import { defineTool } from "../../types/tool.js";
import type { DirEntry } from "../../types/platform.js";

const DEFAULT_LIMIT = 250;

export const lsTool = defineTool({
  name: "ls",
  description:
    "List the immediate entries of a directory (names, type, size, modification time). Not recursive — use glob for recursive file discovery.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or cwd-relative directory to list."),
    limit: z.number().int().positive().optional().describe("Max entries to return. Default 250."),
  }),
  call: async ({ path: dirPath, limit }, platform) => {
    const resolved = platform.resolvePath(dirPath);
    const all = await platform.listDir(resolved);

    const cap = limit ?? DEFAULT_LIMIT;
    const truncated = all.length > cap;
    const entries: DirEntry[] = truncated ? all.slice(0, cap) : all;

    return { entries, truncated };
  },
  isConcurrencySafe: () => true,
});
