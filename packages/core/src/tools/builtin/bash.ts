import { z } from "zod";
import { defineTool } from "../../types/tool.js";

export const bashTool = defineTool({
  name: "bash",
  description:
    "Execute a shell command using /bin/sh. Supports pipes, redirects, &&, ;, and other shell operators.\n" +
    "Returns stdout, stderr, and exit code. A non-zero exit code means the command failed.\n" +
    "Default timeout: 120 seconds (max: 600 seconds). Prefer dedicated tools (read_file, write_file, edit_file) over shell commands when available.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute. Supports pipes, redirects, and shell operators."),
    timeout: z.number().int().positive().optional()
      .describe("Timeout in milliseconds (max 600000). Default: 120000."),
    description: z.string().optional()
      .describe("Human-readable summary of what this command does. Logged but not used in execution."),
  }),
  call: async (input, platform, context) => {
    const rawTimeout = input.timeout ?? 120_000;
    const clampedTimeout = Math.min(rawTimeout, 600_000);
    const clamped = clampedTimeout < rawTimeout;

    const execOptions = {
      shell: true,
      cwd: platform.cwd(),
      timeout: clampedTimeout,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    };

    const result = await platform.exec(input.command, execOptions);

    const stderr = clamped
      ? result.stderr
        ? `${result.stderr}\n[timeout clamped to 600000ms]`
        : "[timeout clamped to 600000ms]"
      : result.stderr;

    return { stdout: result.stdout, stderr, exitCode: result.exitCode };
  },
});
