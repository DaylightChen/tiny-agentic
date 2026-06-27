export type ExecOptions = {
  cwd?: string;
  timeout?: number;   // milliseconds
  env?: Record<string, string>;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export interface Platform {
  /** Return the current working directory. The only place process.cwd() is called is NodePlatform. */
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
