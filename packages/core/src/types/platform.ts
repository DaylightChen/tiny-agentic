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

export interface Platform {
  /** Return the current working directory. Node's working-directory global is read only inside NodePlatform. */
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
