import { describe, it, expect } from "vitest";

import { readFileTool } from "../tools/builtin/readFile.js";
import { writeFileTool } from "../tools/builtin/writeFile.js";
import type { Platform, ExecResult } from "../types/platform.js";
import type { ToolCallContext } from "../types/tool.js";

/**
 * In-memory Platform backed by a Map. writeFile mutations are observable via the
 * map, and readFile reflects them. readFile rejects on a missing path so that the
 * write-tool's range mode (which read-modify-writes) and the read tool both see
 * realistic "file not found" behavior.
 */
class MockPlatform implements Platform {
  readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  cwd(): string {
    return "/work";
  }
  readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: no such file: ${path}`));
    }
    return Promise.resolve(content);
  }
  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  exec(): Promise<ExecResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  listDir() {
    return Promise.reject(new Error("not configured"));
  }
  stat() {
    return Promise.reject(new Error("not configured"));
  }
  glob() {
    return Promise.reject(new Error("not configured"));
  }
  grep() {
    return Promise.reject(new Error("not configured"));
  }
}

const ctx: ToolCallContext = {};

describe("read_file tool", () => {
  it("no range → returns the whole file as { content } with no extra fields", async () => {
    const platform = new MockPlatform({ "/f.txt": "l1\nl2\nl3\nl4\nl5" });

    const result = await readFileTool.call({ path: "/f.txt" }, platform, ctx);

    expect(result).toEqual({ content: "l1\nl2\nl3\nl4\nl5" });
    // No range fields when neither offset nor limit is supplied.
    expect(Object.keys(result as object)).toEqual(["content"]);
  });

  it("offset only → returns lines from offset through end, with range metadata", async () => {
    const platform = new MockPlatform({ "/f.txt": "l1\nl2\nl3\nl4\nl5" });

    const result = await readFileTool.call({ path: "/f.txt", offset: 2 }, platform, ctx);

    expect(result).toEqual({
      content: "l2\nl3\nl4\nl5",
      offset: 2,
      lineCount: 4,
      totalLines: 5,
      truncated: true,
    });
  });

  it("offset + limit → returns exactly `limit` lines starting at offset", async () => {
    const platform = new MockPlatform({ "/f.txt": "l1\nl2\nl3\nl4\nl5" });

    const result = await readFileTool.call({ path: "/f.txt", offset: 2, limit: 2 }, platform, ctx);

    expect(result).toEqual({
      content: "l2\nl3",
      offset: 2,
      lineCount: 2,
      totalLines: 5,
      truncated: true,
    });
  });

  it("limit only → returns the first `limit` lines starting at offset 1", async () => {
    const platform = new MockPlatform({ "/f.txt": "l1\nl2\nl3\nl4\nl5" });

    const result = await readFileTool.call({ path: "/f.txt", limit: 2 }, platform, ctx);

    expect(result).toEqual({
      content: "l1\nl2",
      offset: 1,
      lineCount: 2,
      totalLines: 5,
      truncated: true,
    });
  });

  it("range covering the whole file → truncated is false", async () => {
    const platform = new MockPlatform({ "/f.txt": "l1\nl2\nl3" });

    const result = await readFileTool.call({ path: "/f.txt", offset: 1, limit: 3 }, platform, ctx);

    expect(result).toEqual({
      content: "l1\nl2\nl3",
      offset: 1,
      lineCount: 3,
      totalLines: 3,
      truncated: false,
    });
  });

  it("rejects a missing file (platform.readFile throws)", async () => {
    const platform = new MockPlatform();

    await expect(readFileTool.call({ path: "/missing.txt" }, platform, ctx)).rejects.toThrow(/ENOENT/);
  });

  describe("Zod input bounds", () => {
    it("rejects offset: 0", () => {
      const parsed = readFileTool.inputSchema.safeParse({ path: "/f.txt", offset: 0 });
      expect(parsed.success).toBe(false);
    });

    it("rejects negative offset", () => {
      const parsed = readFileTool.inputSchema.safeParse({ path: "/f.txt", offset: -1 });
      expect(parsed.success).toBe(false);
    });

    it("rejects non-integer offset", () => {
      const parsed = readFileTool.inputSchema.safeParse({ path: "/f.txt", offset: 1.5 });
      expect(parsed.success).toBe(false);
    });

    it("rejects limit: 0 (read limit must be positive)", () => {
      const parsed = readFileTool.inputSchema.safeParse({ path: "/f.txt", limit: 0 });
      expect(parsed.success).toBe(false);
    });

    it("accepts a valid offset/limit pair", () => {
      const parsed = readFileTool.inputSchema.safeParse({ path: "/f.txt", offset: 2, limit: 3 });
      expect(parsed.success).toBe(true);
    });
  });
});

describe("write_file tool", () => {
  it("no offset → full overwrite of an existing file, returns { written, path }", async () => {
    const platform = new MockPlatform({ "/f.txt": "old content" });

    const result = await writeFileTool.call(
      { path: "/f.txt", content: "brand new" },
      platform,
      ctx,
    );

    expect(platform.files.get("/f.txt")).toBe("brand new");
    expect(result).toEqual({ written: true, path: "/f.txt" });
  });

  it("no offset → creates a missing file", async () => {
    const platform = new MockPlatform();

    const result = await writeFileTool.call(
      { path: "/new.txt", content: "hello" },
      platform,
      ctx,
    );

    expect(platform.files.get("/new.txt")).toBe("hello");
    expect(result).toEqual({ written: true, path: "/new.txt" });
  });

  it("offset + limit → splices the given range, returns replacedFrom/replacedLines", async () => {
    const platform = new MockPlatform({ "/f.txt": "a\nb\nc\nd" });

    const result = await writeFileTool.call(
      { path: "/f.txt", offset: 2, limit: 2, content: "X\nY" },
      platform,
      ctx,
    );

    // Lines 2..3 ("b","c") replaced by "X","Y"; line 4 ("d") preserved.
    expect(platform.files.get("/f.txt")).toBe("a\nX\nY\nd");
    expect(result).toEqual({
      written: true,
      path: "/f.txt",
      replacedFrom: 2,
      replacedLines: 2,
    });
  });

  it("offset, no limit → replaces from offset through end of file", async () => {
    const platform = new MockPlatform({ "/f.txt": "a\nb\nc" });

    const result = await writeFileTool.call(
      { path: "/f.txt", offset: 2, content: "Z" },
      platform,
      ctx,
    );

    // From line 2 to EOF ("b","c") replaced by "Z".
    expect(platform.files.get("/f.txt")).toBe("a\nZ");
    // Default deleteCount = totalLines(3) - start(1) = 2.
    expect(result).toEqual({
      written: true,
      path: "/f.txt",
      replacedFrom: 2,
      replacedLines: 2,
    });
  });

  it("limit 0 → inserts content at offset without deleting", async () => {
    const platform = new MockPlatform({ "/f.txt": "a\nb" });

    const result = await writeFileTool.call(
      { path: "/f.txt", offset: 2, limit: 0, content: "X" },
      platform,
      ctx,
    );

    // "X" inserted before line 2; nothing deleted.
    expect(platform.files.get("/f.txt")).toBe("a\nX\nb");
    expect(result).toEqual({
      written: true,
      path: "/f.txt",
      replacedFrom: 2,
      replacedLines: 0,
    });
  });

  it("range mode on a MISSING file → rejects (platform.readFile throws)", async () => {
    const platform = new MockPlatform();

    await expect(
      writeFileTool.call({ path: "/missing.txt", offset: 1, content: "x" }, platform, ctx),
    ).rejects.toThrow(/ENOENT/);
    // No file was created as a side effect of the failed range write.
    expect(platform.files.has("/missing.txt")).toBe(false);
  });

  describe("Zod input bounds", () => {
    it("rejects negative offset", () => {
      const parsed = writeFileTool.inputSchema.safeParse({
        path: "/f.txt",
        content: "x",
        offset: -1,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects offset: 0", () => {
      const parsed = writeFileTool.inputSchema.safeParse({
        path: "/f.txt",
        content: "x",
        offset: 0,
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts limit: 0 (insert mode, nonnegative)", () => {
      const parsed = writeFileTool.inputSchema.safeParse({
        path: "/f.txt",
        content: "x",
        offset: 2,
        limit: 0,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects negative limit", () => {
      const parsed = writeFileTool.inputSchema.safeParse({
        path: "/f.txt",
        content: "x",
        offset: 2,
        limit: -1,
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts a no-offset full-overwrite input", () => {
      const parsed = writeFileTool.inputSchema.safeParse({ path: "/f.txt", content: "x" });
      expect(parsed.success).toBe(true);
    });
  });
});
