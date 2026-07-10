import path from "node:path";

/**
 * Format an absolute path for return to the model: cwd-relative when it lives
 * under `cwd` (saves tokens), else kept absolute. Shared by the discovery tools
 * (ls/glob/grep) so returned-path form is uniform across them.
 */
export function toReturnPath(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  if (rel === "" ) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
  return rel;
}
