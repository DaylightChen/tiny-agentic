import { describe, it, expect } from "vitest";

import { editFileTool } from "../tools/builtin/editFile.js";
import type { Platform, ExecResult } from "../types/platform.js";
import type { ToolCallContext } from "../types/tool.js";

/**
 * In-memory Platform backed by a Map. readFile rejects for missing paths
 * (ENOENT simulation). writeFile mutations are observable via the map.
 * readCallCount and writeCallCount let tests assert whether I/O was skipped.
 */
class MockPlatform implements Platform {
  readonly files = new Map<string, string>();
  readCallCount = 0;
  writeCallCount = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  cwd(): string {
    return "/work";
  }

  readFile(path: string): Promise<string> {
    this.readCallCount++;
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: no such file: ${path}`));
    }
    return Promise.resolve(content);
  }

  writeFile(path: string, content: string): Promise<void> {
    this.writeCallCount++;
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

describe("edit_file tool", () => {
  describe("tool identity", () => {
    it("has name 'edit_file'", () => {
      expect(editFileTool.name).toBe("edit_file");
    });
  });

  describe("unique match — happy path", () => {
    it("replaces the single occurrence, calls writeFile with updated content, returns { edited: true, path }", async () => {
      const platform = new MockPlatform({ "/f.txt": "hello world" });

      const result = await editFileTool.call(
        { file_path: "/f.txt", old_string: "world", new_string: "earth" },
        platform,
        ctx,
      );

      expect(platform.files.get("/f.txt")).toBe("hello earth");
      expect(platform.writeCallCount).toBe(1);
      expect(result).toEqual({ edited: true, path: "/f.txt" });
    });
  });

  describe("no match", () => {
    it("rejects with 'String to replace not found in file.' when old_string is absent", async () => {
      const platform = new MockPlatform({ "/f.txt": "hello world" });

      await expect(
        editFileTool.call(
          { file_path: "/f.txt", old_string: "xyz", new_string: "abc" },
          platform,
          ctx,
        ),
      ).rejects.toThrow("String to replace not found in file.");
    });
  });

  describe("two matches, replace_all: false (default)", () => {
    it("rejects with exact duplicate-match error message", async () => {
      const platform = new MockPlatform({ "/f.txt": "aXbXc" });

      await expect(
        editFileTool.call(
          { file_path: "/f.txt", old_string: "X", new_string: "_" },
          platform,
          ctx,
        ),
      ).rejects.toThrow(
        "Found 2 matches of old_string but replace_all is false. Provide more context to make the match unique.",
      );
    });
  });

  describe("two matches, replace_all: true", () => {
    it("replaces all occurrences, calls writeFile with fully-replaced content, returns { edited: true, path }", async () => {
      const platform = new MockPlatform({ "/f.txt": "aXbXc" });

      const result = await editFileTool.call(
        { file_path: "/f.txt", old_string: "X", new_string: "_", replace_all: true },
        platform,
        ctx,
      );

      expect(platform.files.get("/f.txt")).toBe("a_b_c");
      expect(platform.writeCallCount).toBe(1);
      expect(result).toEqual({ edited: true, path: "/f.txt" });
    });
  });

  describe("no-op guard — old_string === new_string", () => {
    it("rejects with identity-check error and never calls readFile", async () => {
      const platform = new MockPlatform({ "/f.txt": "hello world" });

      await expect(
        editFileTool.call(
          { file_path: "/f.txt", old_string: "world", new_string: "world" },
          platform,
          ctx,
        ),
      ).rejects.toThrow("No changes to make — old_string and new_string are identical.");

      expect(platform.readCallCount).toBe(0);
    });
  });

  describe("file creation — old_string === '', file missing", () => {
    it("writes new_string as full file content and returns { edited: true, path }", async () => {
      const platform = new MockPlatform();

      const result = await editFileTool.call(
        { file_path: "/new.txt", old_string: "", new_string: "brand new content" },
        platform,
        ctx,
      );

      expect(platform.files.get("/new.txt")).toBe("brand new content");
      expect(platform.writeCallCount).toBe(1);
      expect(result).toEqual({ edited: true, path: "/new.txt" });
    });
  });

  describe("file creation guard — old_string === '', file exists", () => {
    it("rejects with the 'file already exists' error and never calls writeFile", async () => {
      const platform = new MockPlatform({ "/existing.txt": "existing content" });

      await expect(
        editFileTool.call(
          { file_path: "/existing.txt", old_string: "", new_string: "replacement" },
          platform,
          ctx,
        ),
      ).rejects.toThrow("old_string must not be empty when the file already exists.");

      expect(platform.writeCallCount).toBe(0);
    });
  });

  describe("file missing, non-empty old_string", () => {
    it("rejects with 'File does not exist.' when the file is absent", async () => {
      const platform = new MockPlatform();

      await expect(
        editFileTool.call(
          { file_path: "/missing.txt", old_string: "something", new_string: "other" },
          platform,
          ctx,
        ),
      ).rejects.toThrow("File does not exist.");
    });
  });

  describe("input schema validation", () => {
    it("accepts a valid input with all required fields", () => {
      const parsed = editFileTool.inputSchema.safeParse({
        file_path: "/f.txt",
        old_string: "hello",
        new_string: "world",
      });
      expect(parsed.success).toBe(true);
    });

    it("replace_all is falsy (undefined) when omitted — behaves as false", () => {
      const parsed = editFileTool.inputSchema.safeParse({
        file_path: "/f.txt",
        old_string: "hello",
        new_string: "world",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // The schema uses .default(false).optional() — Zod yields undefined when
        // the field is absent. The implementation uses !input.replace_all (falsy),
        // so undefined and false are both treated as "no replace_all".
        expect(parsed.data.replace_all).toBeFalsy();
      }
    });

    it("accepts replace_all: true explicitly", () => {
      const parsed = editFileTool.inputSchema.safeParse({
        file_path: "/f.txt",
        old_string: "hello",
        new_string: "world",
        replace_all: true,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects when file_path is missing", () => {
      const parsed = editFileTool.inputSchema.safeParse({
        old_string: "hello",
        new_string: "world",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects when old_string is missing", () => {
      const parsed = editFileTool.inputSchema.safeParse({
        file_path: "/f.txt",
        new_string: "world",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects when new_string is missing", () => {
      const parsed = editFileTool.inputSchema.safeParse({
        file_path: "/f.txt",
        old_string: "hello",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects when all required fields are missing", () => {
      const parsed = editFileTool.inputSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });
  });
});
