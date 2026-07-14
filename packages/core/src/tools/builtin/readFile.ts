import { z } from "zod";
import { defineTool } from "../../types/tool.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a file at the given path. By default returns the whole file; pass offset/limit to read only a line range (useful for large files).",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file."),
    offset: z.number().int().positive().optional().describe("1-based line number to start reading from."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to read starting at offset."),
  }),
  call: async ({ path, offset, limit }, platform) => {
    const full = await platform.readFile(path);
    if (offset === undefined && limit === undefined) return { content: full };
    const lines = full.split("\n");
    const start = offset !== undefined ? offset - 1 : 0;
    const end = limit !== undefined ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    return { content: slice.join("\n"), offset: start + 1, lineCount: slice.length, totalLines: lines.length, truncated: slice.length < lines.length };
  },
  isConcurrencySafe: () => true,
});
