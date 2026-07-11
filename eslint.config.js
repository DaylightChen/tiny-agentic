import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/*.config.ts", "**/*.config.js"] },
  ...tseslint.configs.recommended,
  // Allow intentionally-unused identifiers prefixed with `_`. The code-architecture
  // skeletons use this convention pervasively for required-but-unused parameters
  // (e.g. `_ctx` in a Tool.call that needs no context, `_req`/`_signal` in mock
  // providers). Without this, `@typescript-eslint/no-unused-vars` errors on them.
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  // Core package: no UI deps, no Node built-ins / `process` outside platform/node.ts.
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/platform/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "tiny-agentic-sdk", message: "core must not import the SDK layer (one-way deps: UI → SDK → core)." },
          { name: "tiny-agentic-ui",  message: "core must not import the UI layer (one-way deps: UI → SDK → core)." },
          { name: "fs",               message: "core is filesystem-free; use the injected Platform. fs is allowed only in platform/node.ts." },
          { name: "node:fs",          message: "core is filesystem-free; use the injected Platform." },
          { name: "fs/promises",      message: "core is filesystem-free; use the injected Platform." },
          { name: "node:fs/promises", message: "core is filesystem-free; use the injected Platform." },
          { name: "child_process",    message: "core is shell-free; use platform.exec." },
          { name: "node:child_process", message: "core is shell-free; use platform.exec." },
        ],
        patterns: [
          { group: ["react", "react-dom", "ink", "chalk", "ora"], message: "core is UI-free (success criterion 7.11)." },
        ],
      }],
      // Block bare `process` references in core (success criterion 7.12 extension).
      "no-restricted-globals": ["error", { name: "process", message: "core must not reference `process`; cwd comes from platform.cwd(). Allowed only in platform/node.ts." }],
    },
  },
  // SDK package: may import core, not UI.
  {
    files: ["packages/sdk/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "tiny-agentic-ui", message: "SDK must not import the UI layer." }],
      }],
    },
  },
);
