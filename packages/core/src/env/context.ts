import type { Platform } from "../types/platform.js";

/**
 * Build the env context block prepended to the system prompt.
 * Calls platform.exec() for git information; failures are silently omitted (§6.15).
 * Called once per agent.run() invocation; not memoized at the core level.
 */
export async function buildEnvContext(platform: Platform): Promise<string> {
  const lines: string[] = [];

  // Working directory — obtained via platform.cwd() so this module stays
  // environment-agnostic (no process reference allowed outside platform/node.ts).
  lines.push(`Working directory: ${platform.cwd()}`);

  // Date (always present; new Date() is universal, not Node-specific)
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

  // Git branch (omit on failure)
  try {
    const branchResult = await platform.exec("git rev-parse --abbrev-ref HEAD");
    if (branchResult.exitCode === 0) {
      lines.push(`Git branch: ${branchResult.stdout.trim()}`);
    }
  } catch {
    // not a git repo or git not installed — silently omit
  }

  // Git status summary (omit on failure)
  try {
    const statusResult = await platform.exec("git status --short");
    if (statusResult.exitCode === 0) {
      const statusLines = statusResult.stdout.trim().split("\n").filter(Boolean);
      if (statusLines.length > 0) {
        lines.push(`Git status: ${statusLines.length} file(s) modified`);
      } else {
        lines.push("Git status: clean");
      }
    }
  } catch {
    // silently omit
  }

  return lines.join("\n");
}
