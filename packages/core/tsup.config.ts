import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index:               "src/index.ts",
    "providers/anthropic": "src/providers/anthropic.ts",
    "platform/node":     "src/platform/node.ts",
    "utils/collect":     "src/utils/collect.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
