import { z } from "zod";
import { defineTool } from "../../types/tool.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Write content to a file. Without offset, replaces the whole file (creating it if needed). With offset (1-based) and optional limit, replaces that line range in an existing file with the given content (read-modify-write).",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file."),
    content: z.string().describe("Content to write (or to substitute into the line range)."),
    offset: z.number().int().positive().optional().describe("1-based start line. If set, replace a line range instead of the whole file."),
    limit: z.number().int().nonnegative().optional().describe("Number of lines to replace starting at offset (default: through end of file). 0 inserts without deleting."),
  }),
  call: async ({ path, content, offset, limit }, platform) => {
    if (offset === undefined) {
      await platform.writeFile(path, content);
      return { written: true, path };
    }
    const existing = await platform.readFile(path); // throws if missing → caught by loop as tool error
    const lines = existing.split("\n");
    const start = offset - 1;
    // Clamp to >= 0 so an offset past EOF appends cleanly (rather than reporting a
    // negative replacedLines); splice already treats start > length as "append".
    const deleteCount = Math.max(0, limit !== undefined ? limit : lines.length - start);
    lines.splice(start, deleteCount, ...content.split("\n"));
    await platform.writeFile(path, lines.join("\n"));
    return { written: true, path, replacedFrom: offset, replacedLines: deleteCount };
  },
});
