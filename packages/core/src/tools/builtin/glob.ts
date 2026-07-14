import { z } from "zod";
import { defineTool } from "../../types/tool.js";
import type { GlobOptions } from "../../types/platform.js";

const DEFAULT_LIMIT = 250;

export const globTool = defineTool({
  name: "glob",
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Returns matched paths in the configured Platform’s display order. Does not search file contents — use grep for that.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts".'),
    path: z.string().optional().describe("Base directory to glob from. Defaults to the working directory."),
    respect_gitignore: z.boolean().optional().describe("Skip .gitignore-d files. Default true."),
    include_hidden: z.boolean().optional().describe("Include dotfiles/dotdirs. Default false."),
    limit: z.number().int().positive().optional().describe("Max files to return. Default 250."),
  }),
  call: async ({ pattern, path, respect_gitignore, include_hidden, limit }, platform, context) => {
    const options: GlobOptions = {
      respectGitignore: respect_gitignore ?? true,
      includeHidden: include_hidden ?? false,
      limit: limit ?? DEFAULT_LIMIT,
      ...(path !== undefined ? { cwd: platform.resolvePath(path) } : {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    };

    const { paths, truncated } = await platform.glob(pattern, options);
    const files = paths.map((path) => platform.formatPath(path));

    return { files, truncated };
  },
  isConcurrencySafe: () => true,
});
