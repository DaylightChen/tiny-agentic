export type ExecOptions = {
  cwd?: string;
  timeout?: number;   // milliseconds
  env?: Record<string, string>;
  shell?: boolean;       // if true, use system shell (/bin/sh on Unix)
  signal?: AbortSignal;  // forward to execFile for abort support
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type DirEntry = {
  name: string;                         // basename only
  type: "file" | "directory" | "symlink" | "other";
  size: number;                         // bytes; 0 for directories
  mtimeMs: number;                      // modification time, ms since epoch
};

export type GlobOptions = {
  cwd?: string;                         // base dir; defaults to platform.cwd()
  respectGitignore?: boolean;           // default true
  includeHidden?: boolean;              // default false (dotfiles excluded)
  limit?: number;                       // max paths returned (caller applies cap)
  signal?: AbortSignal;
};

export type GlobResult = {
  paths: string[];                      // absolute paths in final display order
  truncated: boolean;                   // more matched than `limit`
};

export type GrepMatch = {
  file: string;
  line: number;                         // 1-based line number
  text: string;                         // the line's text (per-line-length-capped)
  kind: "match" | "context";            // "context" = an -A/-B/-C context line, not itself a match
};

export type GrepOptions = {
  cwd?: string;                         // search root; defaults to platform.cwd()
  path?: string;                        // restrict to this file or subtree
  glob?: string;                        // file-name filter (e.g. "*.ts")
  ignoreCase?: boolean;                 // default false
  respectGitignore?: boolean;           // default true
  includeHidden?: boolean;              // default false
  limit?: number;                       // max files (or MATCH lines in content mode; context lines don't count)
  maxLineLength?: number;               // per-line cap in content mode
  contentMode?: boolean;                // collect matching lines, not just files
  before?: number;                      // -B: context lines before each match (default 0)
  after?: number;                       // -A: context lines after each match (default 0)
  signal?: AbortSignal;
};

export type GrepPlatformResult = {
  files: string[];                      // absolute paths with >=1 match, in final display order
  matches?: GrepMatch[];                // present iff contentMode; grouped by file order, then line ascending
  truncated: boolean;
};

export interface Platform {
  /** Resolve an absolute or platform-relative model path against this platform's cwd. */
  resolvePath(path: string): string;

  /** Format a resolved path for model output: cwd-relative when inside cwd,
   *  "." when equal to cwd, otherwise unchanged absolute/canonical form. */
  formatPath(path: string): string;

  /** Return the current working directory. Node's working-directory global is read only inside NodePlatform. */
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // --- new in fs-discovery ---
  /** List the immediate entries of `path` (non-recursive) in final display order.
   *  Rejects if `path` does not exist or is not a directory. */
  listDir(path: string): Promise<DirEntry[]>;
  /** Stat a single path. Rejects if it does not exist. */
  stat(path: string): Promise<DirEntry>;
  /** Find files matching a glob pattern in final display order.
   *  See GlobOptions for ignore/hidden/cap. */
  glob(pattern: string, options?: GlobOptions): Promise<GlobResult>;
  /** Search file contents by regex source (JS RegExp syntax). `flags` is the
   *  RegExp flags string (e.g. "i" for case-insensitive; the tool derives it).
   *  Files are in final display order; matches are grouped by that file order,
   *  then line ascending. Rejects on invalid regex or when an explicit
   *  `options.path` does not exist. */
  grep(pattern: string, flags: string, options?: GrepOptions): Promise<GrepPlatformResult>;
}
