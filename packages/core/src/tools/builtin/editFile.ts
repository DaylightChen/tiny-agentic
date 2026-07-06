import { z } from "zod";
import { defineTool } from "../../types/tool.js";

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Make a targeted edit to a file by replacing an exact string. old_string must match exactly once (unless replace_all is true). An empty old_string creates the file if it does not exist.",
  inputSchema: z.object({
    file_path: z.string().describe("Absolute or relative path to the file."),
    old_string: z.string().describe("Exact text to find and replace. Empty string creates the file."),
    new_string: z.string().describe("Text to replace old_string with."),
    replace_all: z.boolean().default(false).optional()
      .describe("If true, replace all occurrences. If false (default), old_string must appear exactly once."),
  }),
  call: async (input, platform) => {
    // Step 1 — No-op guard (before any file I/O):
    if (input.old_string === input.new_string) {
      throw new Error("No changes to make — old_string and new_string are identical.");
    }

    // Step 2 — File creation path (empty old_string):
    if (input.old_string === "") {
      try {
        await platform.readFile(input.file_path);
        // File exists — reject:
        throw new Error("old_string must not be empty when the file already exists.");
      } catch (err) {
        if (err instanceof Error && err.message.includes("old_string must not be empty")) {
          throw err; // re-throw our own error, not ENOENT
        }
        // Any other error = file missing (ENOENT). Create it:
        await platform.writeFile(input.file_path, input.new_string);
        return { edited: true, path: input.file_path };
      }
    }

    // Step 3 — Normal edit path (non-empty old_string):
    // Check file existence:
    let content: string;
    try {
      content = await platform.readFile(input.file_path);
    } catch {
      throw new Error("File does not exist.");
    }
    // Count occurrences (exact substring, no regex):
    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      throw new Error("String to replace not found in file.");
    }
    if (count > 1 && !input.replace_all) {
      throw new Error(
        `Found ${count} matches of old_string but replace_all is false. Provide more context to make the match unique.`
      );
    }
    // Perform replacement:
    const newContent = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string); // replaces first occurrence
    await platform.writeFile(input.file_path, newContent);
    return { edited: true, path: input.file_path };
  },
});
