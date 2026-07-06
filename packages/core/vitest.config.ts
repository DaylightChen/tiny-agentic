import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // The suite is populated incrementally (first tests land in task 03).
    // Without this, `vitest run` exits 1 on "no test files found", breaking
    // the workspace-level `pnpm -r test` health check until then.
    passWithNoTests: true,
  },
});
