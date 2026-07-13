import { z } from "zod";
import { defineTool } from "../../types/tool.js";
import type { GrepMatch, GrepOptions } from "../../types/platform.js";

const DEFAULT_LIMIT = 250;
const MAX_LINE_LENGTH = 500;
/** Total serialized-result guard: truncate content output at a match boundary. */
const MAX_RESULT_CHARS = 20_000;

type ContentEntry = { file: string; line: number; text: string; kind: "match" | "context" };

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents by regular expression. Returns matching files, matching lines, or a count depending on output_mode. Respects .gitignore by default.",
  inputSchema: z.object({
    pattern: z.string().describe("Regular expression (JS RegExp syntax)."),
    path: z.string().optional()
      .describe("File or directory to search. Defaults to the working directory."),
    glob: z.string().optional()
      .describe('File-name filter, e.g. "*.ts".'),
    output_mode: z.enum(["files_with_matches", "content", "count"]).optional()
      .describe("What to return. Default files_with_matches."),
    case_insensitive: z.boolean().optional()
      .describe("Case-insensitive match. Default false."),
    respect_gitignore: z.boolean().optional()
      .describe("Skip .gitignore-d files. Default true."),
    include_hidden: z.boolean().optional()
      .describe("Search dotfiles/dotdirs. Default false."),
    before_context: z.number().int().positive().optional()
      .describe("Lines of context to include BEFORE each match (like grep -B). content mode only."),
    after_context: z.number().int().positive().optional()
      .describe("Lines of context to include AFTER each match (like grep -A). content mode only."),
    context: z.number().int().positive().optional()
      .describe("Lines of context BOTH before and after each match (like grep -C). Overrides before/after if set. content mode only."),
    limit: z.number().int().positive().optional()
      .describe("Max files (or matching lines in content mode; context lines do not count toward the limit). Default 250."),
  }),
  call: async (input, platform, context) => {
    const {
      pattern,
      path,
      glob,
      output_mode,
      case_insensitive,
      respect_gitignore,
      include_hidden,
      before_context,
      after_context,
      context: contextLines,
      limit,
    } = input;

    const mode = output_mode ?? "files_with_matches";
    const flags = case_insensitive ? "i" : "";

    // Compile + validate in the tool so the model gets a fixable message.
    try {
      new RegExp(pattern, flags);
    } catch (e) {
      throw new Error("grep: invalid regular expression: " + (e as Error).message);
    }

    // Context resolution: a set `context` wins over before/after.
    const before = contextLines !== undefined ? contextLines : before_context ?? 0;
    const after = contextLines !== undefined ? contextLines : after_context ?? 0;
    const contentMode = mode === "content";

    const options: GrepOptions = {
      respectGitignore: respect_gitignore ?? true,
      includeHidden: include_hidden ?? false,
      limit: limit ?? DEFAULT_LIMIT,
      contentMode,
      maxLineLength: MAX_LINE_LENGTH,
      before,
      after,
      ...(path !== undefined ? { path: platform.resolvePath(path) } : {}),
      ...(glob !== undefined ? { glob } : {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    };

    const result = await platform.grep(pattern, flags, options);

    if (mode === "files_with_matches") {
      return {
        mode: "files_with_matches" as const,
        files: result.files.map((file) => platform.formatPath(file)),
        truncated: result.truncated,
      };
    }

    if (mode === "count") {
      return {
        mode: "count" as const,
        count: result.files.length,
        files: result.files.map((file) => platform.formatPath(file)),
        truncated: result.truncated,
      };
    }

    // content mode: relativize + apply the total-result guard at a match boundary.
    const raw: GrepMatch[] = result.matches ?? [];
    const entries: ContentEntry[] = [];
    let total = 0;
    let truncated = result.truncated;

    for (let i = 0; i < raw.length; i++) {
      const m = raw[i]!;
      const entry: ContentEntry = {
        file: platform.formatPath(m.file),
        line: m.line,
        text: m.text,
        kind: m.kind,
      };
      const cost = entry.file.length + entry.text.length + 16;
      if (total + cost > MAX_RESULT_CHARS && entries.length > 0) {
        // Truncate at a match boundary: drop back to the entry before this
        // match's window so no partial match window is emitted.
        truncated = true;
        while (entries.length > 0 && entries[entries.length - 1]!.kind === "context") {
          entries.pop();
        }
        break;
      }
      total += cost;
      entries.push(entry);
    }

    return { mode: "content" as const, matches: entries, truncated };
  },
  isConcurrencySafe: () => true,
});
