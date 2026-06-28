import { describe, it, expect } from "vitest";
import { z } from "zod";

import { buildEnvContext } from "../env/context.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../types/tool.js";
import type { Platform, ExecResult } from "../types/platform.js";

/**
 * Inline mock Platform with a scripted exec queue.
 *
 * `exec` shifts the next scripted response off `execResponses` per call.
 * When the queue is exhausted it returns a benign `{ exitCode: 0 }` default,
 * matching the shape used by Task 08's MockPlatform (code-architecture §8.2).
 * To simulate a thrown exec (no git binary / not a repo), set `throwOnExec`.
 */
class MockPlatform implements Platform {
  private files: Record<string, string>;
  execResponses: ExecResult[];
  private fakeCwd: string;
  private throwOnExec: Error | null;

  constructor(
    files: Record<string, string> = {},
    execResponses: ExecResult[] = [],
    cwd = "/mock/cwd",
    throwOnExec: Error | null = null,
  ) {
    this.files = files;
    this.execResponses = execResponses;
    this.fakeCwd = cwd;
    this.throwOnExec = throwOnExec;
  }

  cwd(): string {
    return this.fakeCwd;
  }

  async readFile(path: string): Promise<string> {
    const content = this.files[path];
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files[path] = content;
  }

  async exec(): Promise<ExecResult> {
    if (this.throwOnExec) {
      throw this.throwOnExec;
    }
    return this.execResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("buildEnvContext (7.13 env context injection)", () => {
  it("happy path: emits cwd, date, git branch, and modified-file status", async () => {
    const platform = new MockPlatform(
      {},
      [
        { stdout: "main\n", stderr: "", exitCode: 0 }, // git rev-parse (branch)
        { stdout: " M foo.ts\n", stderr: "", exitCode: 0 }, // git status --short
      ],
      "/test/dir",
    );

    const result = await buildEnvContext(platform);

    expect(result).toContain("Working directory: /test/dir");
    expect(result).toContain("Git branch: main");
    expect(result).toContain("Git status: 1 file(s) modified");

    // Date line present, with today's year as a partial match.
    const year = new Date().toISOString().slice(0, 4);
    expect(result).toContain(`Date: ${year}`);
  });

  it("clean repo: reports 'Git status: clean' when status output is empty", async () => {
    const platform = new MockPlatform(
      {},
      [
        { stdout: "feature\n", stderr: "", exitCode: 0 }, // branch
        { stdout: "", stderr: "", exitCode: 0 }, // status (clean)
      ],
      "/test/dir",
    );

    const result = await buildEnvContext(platform);

    expect(result).toContain("Git branch: feature");
    expect(result).toContain("Git status: clean");
    expect(result).not.toContain("file(s) modified");
  });
});

describe("buildEnvContext (7.15 git-absent degradation)", () => {
  it("exec throws: omits git lines, keeps cwd + date, and does not throw", async () => {
    const platform = new MockPlatform(
      {},
      [],
      "/test/dir",
      new Error("not a git repo"),
    );

    // Must resolve normally — no error propagated to the caller (7.15).
    const result = await buildEnvContext(platform);

    expect(result).toContain("Working directory: /test/dir");
    expect(result).toContain("Date:");
    expect(result).not.toContain("Git branch:");
    expect(result).not.toContain("Git status:");
  });

  it("non-zero exit (not a repo): omits git lines and returns normally", async () => {
    const platform = new MockPlatform(
      {},
      [
        { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }, // branch
        { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }, // status
      ],
      "/test/dir",
    );

    const result = await buildEnvContext(platform);

    expect(result).toContain("Working directory: /test/dir");
    expect(result).toContain("Date:");
    expect(result).not.toContain("Git branch:");
    expect(result).not.toContain("Git status:");
  });
});

describe("ToolRegistry", () => {
  const readTool = defineTool({
    name: "read_file",
    description: "Reads a file at the given path.",
    inputSchema: z.object({ path: z.string() }),
    call: async ({ path }) => path,
  });

  it("findByName returns the registered tool and undefined for unknown names", () => {
    const registry = new ToolRegistry([readTool]);

    expect(registry.findByName("read_file")).toBe(readTool);
    expect(registry.findByName("nope")).toBeUndefined();
  });

  it("toSchemas serializes the Zod inputSchema to an openApi3 object schema", () => {
    const registry = new ToolRegistry([readTool]);
    const schemas = registry.toSchemas();

    expect(schemas).toHaveLength(1);
    const schema = schemas[0];
    if (!schema) throw new Error("expected one serialized schema");

    // name/description carried through verbatim.
    expect(schema.name).toBe("read_file");
    expect(schema.description).toBe("Reads a file at the given path.");

    // inputSchema is a JSON-Schema object with the declared property.
    expect(schema.inputSchema.type).toBe("object");
    expect(schema.inputSchema.properties.path).toBeDefined();
    expect((schema.inputSchema.properties.path as { type: string }).type).toBe("string");

    // openApi3 target omits the $schema draft marker.
    expect((schema.inputSchema as Record<string, unknown>).$schema).toBeUndefined();
  });
});
