import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const root = dirname(fileURLToPath(import.meta.url));
const coreSdkImportMessage = "core must not import the SDK layer (one-way deps: UI → SDK → core).";
const coreUiImportMessage = "core must not import the UI layer (one-way deps: UI → SDK → core).";
const coreArchitecturePaths = [
  { name: "tiny-agentic-sdk", message: coreSdkImportMessage },
  { name: "tiny-agentic-ui", message: coreUiImportMessage },
];
const coreUiLibraryImportMessage = "core is UI-free (success criterion 7.11).";
const coreUiLibraryPackages = ["react", "react-dom", "ink", "blessed", "chalk", "ora"];
const coreArchitecturePatterns = [
  { regex: "^tiny-agentic-sdk/", message: coreSdkImportMessage },
  { regex: "^tiny-agentic-ui/", message: coreUiImportMessage },
  {
    regex: "^(?:react|react-dom|ink|blessed|chalk|ora)(?:/|$)|^@inkjs/",
    message: coreUiLibraryImportMessage,
  },
];
const coreEnvironmentMessage =
  "Node built-ins and process are allowed only in packages/core/src/platform/node.ts and packages/core/src/platform/fs-discovery.ts.";
const coreStaticImportMessage =
  "core import targets must use a statically resolvable string literal or no-expression template literal.";
const bareNodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const sdkSource = resolve(root, "packages/sdk");
const uiSource = resolve(root, "packages/ui");
const environmentAllowlist = new Set([
  resolve(root, "packages/core/src/platform/node.ts"),
  resolve(root, "packages/core/src/platform/fs-discovery.ts"),
]);

const importTargetWrapperTypes = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function staticSpecifier(source) {
  let target = source;
  while (target !== null && target !== undefined && importTargetWrapperTypes.has(target.type)) {
    target = target.expression;
  }
  if (target?.type === "Literal" && typeof target.value === "string") return target.value;
  if (target?.type === "TemplateLiteral" && target.expressions.length === 0) {
    const value = target.quasis[0]?.value.cooked ?? target.quasis[0]?.value.raw;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function unwrapImportTypeArgument(argument) {
  let target = argument;
  while (target?.type === "TSLiteralType") target = target.argument ?? target.literal;
  return target;
}

function importTarget(node) {
  if (node.type === "ImportExpression") return node.source;
  if (node.type === "TSImportType") {
    return staticSpecifier(node.source) !== undefined
      ? node.source
      : unwrapImportTypeArgument(node.argument);
  }
  if (
    node.type === "ImportDeclaration"
    || node.type === "ExportNamedDeclaration"
    || node.type === "ExportAllDeclaration"
  ) return node.source;
  return undefined;
}

function uiLibraryPackage(specifier) {
  return specifier.startsWith("@inkjs/")
    || coreUiLibraryPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function packageBoundary(path, directory) {
  const fromDirectory = relative(directory, path);
  return fromDirectory === ""
    || (fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`) && !isAbsolute(fromDirectory));
}

const coreBoundariesPlugin = {
  rules: {
    imports: {
      meta: {
        type: "problem",
        docs: { description: "enforce core import boundaries" },
        schema: [],
        messages: {
          static: coreStaticImportMessage,
          environment: coreEnvironmentMessage,
          sdk: coreSdkImportMessage,
          ui: coreUiImportMessage,
          uiLibrary: coreUiLibraryImportMessage,
        },
      },
      create(context) {
        const physicalFilename = context.physicalFilename ?? context.getPhysicalFilename?.() ?? context.getFilename();
        const filename = resolve(physicalFilename);
        const allowEnvironment = environmentAllowlist.has(filename);

        function check(node) {
          const target = importTarget(node);
          if (target === undefined) return;
          const specifier = staticSpecifier(target);
          if (specifier === undefined) {
            if (node.type === "ImportExpression" || node.type === "TSImportType") {
              context.report({ node, messageId: "static" });
            }
            return;
          }

          const bareBuiltin = specifier.split("/")[0];
          if (
            !allowEnvironment
            && (specifier.startsWith("node:") || bareNodeBuiltins.has(bareBuiltin))
          ) {
            context.report({ node: target, messageId: "environment" });
          }

          if (specifier === "tiny-agentic-sdk" || specifier.startsWith("tiny-agentic-sdk/")) {
            context.report({ node: target, messageId: "sdk" });
          } else if (specifier === "tiny-agentic-ui" || specifier.startsWith("tiny-agentic-ui/")) {
            context.report({ node: target, messageId: "ui" });
          } else if (uiLibraryPackage(specifier)) {
            context.report({ node: target, messageId: "uiLibrary" });
          }

          if (specifier.startsWith(".") || isAbsolute(specifier)) {
            const resolved = specifier.startsWith(".") ? resolve(dirname(filename), specifier) : resolve(specifier);
            if (packageBoundary(resolved, sdkSource)) context.report({ node: target, messageId: "sdk" });
            if (packageBoundary(resolved, uiSource)) context.report({ node: target, messageId: "ui" });
          }
        }

        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
          TSImportType: check,
        };
      },
    },
  },
};

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
  // Core package architecture rules apply universally, including platform modules.
  {
    files: ["packages/core/src/**/*.ts"],
    plugins: { "core-boundaries": coreBoundariesPlugin },
    rules: {
      "core-boundaries/imports": "error",
      "no-restricted-imports": ["error", {
        paths: coreArchitecturePaths,
        patterns: coreArchitecturePatterns,
      }],
    },
  },
  // Node environment access is confined to the two explicit platform adapters.
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: [
      "packages/core/src/platform/node.ts",
      "packages/core/src/platform/fs-discovery.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          ...coreArchitecturePaths,
          ...[...bareNodeBuiltins].map((name) => ({ name, message: coreEnvironmentMessage })),
        ],
        patterns: [
          ...coreArchitecturePatterns,
          { group: ["node:*"], message: coreEnvironmentMessage },
        ],
      }],
      "no-restricted-globals": [
        "error",
        { name: "process", message: coreEnvironmentMessage },
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "process", message: coreEnvironmentMessage },
        { object: "global", property: "process", message: coreEnvironmentMessage },
      ],
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
