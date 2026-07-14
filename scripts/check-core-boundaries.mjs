#!/usr/bin/env node

import { builtinModules } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { parseForESLint } from "@typescript-eslint/parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreSource = join(root, "packages/core/src");
const builtinSource = join(coreSource, "tools/builtin");
const dist = join(root, "packages/core/dist");
const mainEntry = join(dist, "index.js");
const nodeEntry = join(dist, "platform/node.js");
const allowlistedSources = new Set([
  join(coreSource, "platform/node.ts"),
  join(coreSource, "platform/fs-discovery.ts"),
]);

const bareBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function fail(contract, detail) {
  throw new Error(`${contract} failed: ${detail}`);
}

async function requireFile(path, contract, instruction) {
  try {
    const info = await stat(path);
    if (!info.isFile()) fail(contract, `${path} is not a file`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${contract} failed:`)) throw error;
    fail(contract, `${path} is missing. ${instruction}`);
  }
}

async function listFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, extension));
    else if (entry.isFile() && extname(entry.name) === extension) files.push(path);
  }
  return files.sort();
}

function lintMessages(result) {
  return result.messages
    .map((message) => `${message.ruleId ?? "config"}@${message.line}:${message.column} ${message.message}`)
    .join(" | ");
}

async function lintFixture(eslint, fixture) {
  const [result] = await eslint.lintText(fixture.code, { filePath: fixture.filePath });
  if (result === undefined) fail("PT-9", `ESLint returned no result for ${fixture.name}`);
  const messages = result.messages.filter((message) => message.severity === 2);
  if (fixture.rejected) {
    if (messages.length === 0) {
      fail("PT-9", `ESLint accepted forbidden fixture '${fixture.name}' at ${fixture.filePath}`);
    }
    const ruleMessages = messages.filter((message) => message.ruleId === fixture.ruleId);
    if (ruleMessages.length === 0) {
      fail(
        "PT-9",
        `fixture '${fixture.name}' did not trigger ${fixture.ruleId}; got ${lintMessages(result)}`,
      );
    }
    if (fixture.messageIds !== undefined) {
      const actualMessageIds = ruleMessages.map((message) => message.messageId).sort();
      const expectedMessageIds = [...fixture.messageIds].sort();
      if (
        actualMessageIds.length !== expectedMessageIds.length
        || actualMessageIds.some((messageId, index) => messageId !== expectedMessageIds[index])
      ) {
        fail(
          "PT-9",
          `fixture '${fixture.name}' triggered ${JSON.stringify(actualMessageIds)} instead of ${JSON.stringify(expectedMessageIds)}; got ${lintMessages(result)}`,
        );
      }
    }
  } else if (messages.length > 0) {
    fail("PT-9", `ESLint rejected allowlisted fixture '${fixture.name}': ${lintMessages(result)}`);
  }
}

async function checkLintContracts() {
  const eslint = new ESLint({ cwd: root });
  const fixtures = [
    {
      name: "node:path import",
      filePath: join(coreSource, "__boundary_fixtures__/node-path.ts"),
      code: 'import { join } from "node:path";\nvoid join;\n',
      rejected: true,
      ruleId: "no-restricted-imports",
    },
    {
      name: "bare path import",
      filePath: join(coreSource, "__boundary_fixtures__/bare-path.ts"),
      code: 'import { join } from "path";\nvoid join;\n',
      rejected: true,
      ruleId: "no-restricted-imports",
    },
    {
      name: "bare process",
      filePath: join(coreSource, "__boundary_fixtures__/bare-process.ts"),
      code: "void process.cwd();\n",
      rejected: true,
      ruleId: "no-restricted-globals",
    },
    {
      name: "globalThis.process",
      filePath: join(coreSource, "__boundary_fixtures__/global-this-process.ts"),
      code: "void globalThis.process;\n",
      rejected: true,
      ruleId: "no-restricted-properties",
    },
    {
      name: "global.process",
      filePath: join(coreSource, "__boundary_fixtures__/global-process.ts"),
      code: "void global.process;\n",
      rejected: true,
      ruleId: "no-restricted-properties",
    },
    {
      name: "platform UI package subpath import",
      filePath: join(coreSource, "platform/__boundary_ui_subpath__.ts"),
      code: 'import"tiny-agentic-ui/components";\n',
      rejected: true,
      ruleId: "no-restricted-imports",
    },
    {
      name: "platform SDK package subpath export",
      filePath: join(coreSource, "platform/__boundary_sdk_subpath__.ts"),
      code: 'export*from"tiny-agentic-sdk/client";\n',
      rejected: true,
      ruleId: "no-restricted-imports",
    },
    {
      name: "dynamic UI package subpath import",
      filePath: join(coreSource, "__boundary_fixtures__/dynamic-ui-subpath.ts"),
      code: 'void import("tiny-agentic-ui/components");\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "dynamic React package root import",
      filePath: join(coreSource, "__boundary_fixtures__/dynamic-react.ts"),
      code: 'void import("react");\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "dynamic React package subpath import",
      filePath: join(coreSource, "__boundary_fixtures__/dynamic-react-subpath.ts"),
      code: 'void import(`react/jsx-runtime`);\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "dynamic scoped Ink package import",
      filePath: join(coreSource, "__boundary_fixtures__/dynamic-inkjs.ts"),
      code: 'void import("@inkjs/ui");\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "absolute SDK import",
      filePath: join(coreSource, "__boundary_fixtures__/absolute-sdk.ts"),
      code: `import ${JSON.stringify(join(root, "packages/sdk/src/index.js"))};\n`,
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "absolute UI dynamic import",
      filePath: join(coreSource, "__boundary_fixtures__/absolute-ui.ts"),
      code: `void import(${JSON.stringify(join(root, "packages/ui/src/index.js"))});\n`,
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "dynamic node builtin import",
      filePath: join(coreSource, "__boundary_fixtures__/dynamic-node-fs.ts"),
      code: 'void import(`node:fs`);\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "non-static dynamic import",
      filePath: join(coreSource, "__boundary_fixtures__/non-static-dynamic.ts"),
      code: 'declare const target: string; void import(target);\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "Node TS import type",
      filePath: join(coreSource, "__boundary_fixtures__/node-import-type.ts"),
      code: 'type Stats = import("node:fs").Stats; void (0 as unknown as Stats);\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
      messageIds: ["environment"],
    },
    {
      name: "SDK TS import type",
      filePath: join(coreSource, "__boundary_fixtures__/sdk-import-type.ts"),
      code: 'type Client = import(`tiny-agentic-sdk/client`).Client; void (0 as unknown as Client);\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
      messageIds: ["sdk"],
    },
    {
      name: "absolute UI TS import type",
      filePath: join(coreSource, "__boundary_fixtures__/ui-import-type.ts"),
      code: `type View = import(${JSON.stringify(join(root, "packages/ui/src/index.js"))}).View; void (0 as unknown as View);\n`,
      rejected: true,
      ruleId: "core-boundaries/imports",
      messageIds: ["ui"],
    },
    {
      name: "platform relative upward UI import",
      filePath: join(coreSource, "platform/__boundary_relative_ui__.ts"),
      code: 'import"../../../ui/src/index.js";\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "platform relative upward SDK export",
      filePath: join(coreSource, "platform/__boundary_relative_sdk__.ts"),
      code: 'export*from"../../../sdk/src/index.js";\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "normalized relative UI import",
      filePath: join(coreSource, "platform/deep/__boundary_normalized_ui__.ts"),
      code: 'void import("./nested/../../../../../ui/src/./components.js");\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "normalized relative SDK import",
      filePath: join(coreSource, "__boundary_fixtures__/deep/__boundary_normalized_sdk__.ts"),
      code: 'import "../../../../sdk/src/dir/../index.js";\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "node platform allowlist",
      filePath: join(coreSource, "platform/node.ts"),
      code: 'import { join } from "node:path";\nvoid join;\nvoid process.cwd();\n',
      rejected: false,
    },
    {
      name: "fs-discovery platform allowlist",
      filePath: join(coreSource, "platform/fs-discovery.ts"),
      code: 'import { readFile } from "node:fs/promises";\nvoid readFile;\nvoid globalThis.process;\n',
      rejected: false,
    },
    {
      name: "node platform still rejects UI",
      filePath: join(coreSource, "platform/node.ts"),
      code: 'void import("tiny-agentic-ui/components");\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
    {
      name: "fs-discovery still rejects normalized SDK path",
      filePath: join(coreSource, "platform/fs-discovery.ts"),
      code: 'import "../../../sdk/src/./index.js";\n',
      rejected: true,
      ruleId: "core-boundaries/imports",
    },
  ];

  for (const fixture of fixtures) await lintFixture(eslint, fixture);
  return fixtures.length;
}

function parsedSource(source, file) {
  try {
    return parseForESLint(source, {
      comment: false,
      ecmaVersion: "latest",
      filePath: file,
      jsx: false,
      loc: false,
      range: true,
      sourceType: "module",
      tokens: false,
    });
  } catch (error) {
    fail("boundary scanner", `${relative(root, file)} could not be parsed: ${error instanceof Error ? error.message : error}`);
  }
}

const wrapperTypes = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function unwrap(node) {
  let current = node;
  while (current !== null && current !== undefined && wrapperTypes.has(current.type)) current = current.expression;
  return current;
}

function staticString(node) {
  const target = unwrap(node);
  if (target?.type === "Literal" && typeof target.value === "string") return target.value;
  if (target?.type === "TemplateLiteral" && target.expressions.length === 0) {
    const value = target.quasis[0]?.value.cooked ?? target.quasis[0]?.value.raw;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function staticImportTypeSpecifier(node) {
  const sourceSpecifier = staticString(node.source);
  if (sourceSpecifier !== undefined) return sourceSpecifier;

  let argument = node.argument;
  while (argument?.type === "TSLiteralType") argument = argument.argument ?? argument.literal;
  return staticString(argument);
}

function propertyName(node, computed) {
  const target = unwrap(node);
  if (!computed && target?.type === "Identifier") return target.name;
  return staticString(target);
}

function globalIdentifier(node, name, unresolved) {
  const target = unwrap(node);
  return target?.type === "Identifier" && target.name === name && unresolved.has(target);
}

function destructuresProcess(pattern) {
  return pattern?.type === "ObjectPattern"
    && pattern.properties.some((property) => (
      property.type === "Property" && propertyName(property.key, property.computed) === "process"
    ));
}

function analyzeSource(source, file) {
  const parsed = parsedSource(source, file);
  const specifiers = [];
  const dynamicImports = [];
  const unresolved = new Set(
    (parsed.scopeManager?.globalScope?.through ?? []).map((reference) => reference.identifier),
  );
  let processAccess = false;

  function visit(value) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || typeof value.type !== "string") return;

    const node = value;
    if (
      node.type === "ImportDeclaration"
      || node.type === "ExportNamedDeclaration"
      || node.type === "ExportAllDeclaration"
    ) {
      const specifier = staticString(node.source);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (node.type === "ImportExpression") {
      const specifier = staticString(node.source);
      dynamicImports.push(specifier);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (node.type === "TSImportType") {
      const specifier = staticImportTypeSpecifier(node);
      dynamicImports.push(specifier);
      if (specifier !== undefined) specifiers.push(specifier);
    }

    if (node.type === "Identifier" && node.name === "process" && unresolved.has(node)) {
      processAccess = true;
    }

    if (node.type === "MemberExpression") {
      if (
        propertyName(node.property, node.computed) === "process"
        && (globalIdentifier(node.object, "globalThis", unresolved) || globalIdentifier(node.object, "global", unresolved))
      ) {
        processAccess = true;
      }
    }

    const destructuringPattern = node.type === "VariableDeclarator"
      ? node.id
      : node.type === "AssignmentExpression" ? node.left : undefined;
    const destructuringSource = node.type === "VariableDeclarator"
      ? node.init
      : node.type === "AssignmentExpression" ? node.right : undefined;
    if (
      destructuresProcess(destructuringPattern)
      && (
        globalIdentifier(destructuringSource, "globalThis", unresolved)
        || globalIdentifier(destructuringSource, "global", unresolved)
      )
    ) {
      processAccess = true;
    }

    for (const key of parsed.visitorKeys?.[node.type] ?? []) visit(node[key]);
  }

  visit(parsed.ast);
  return { specifiers, dynamicImports, processAccess };
}

function forbiddenEnvironmentImport(specifier) {
  if (specifier.startsWith("node:")) return true;
  const bare = specifier.split("/")[0];
  return bare !== undefined && bareBuiltins.has(bare);
}

function rejectNonStaticDynamicImports(analysis, contract, file) {
  if (analysis.dynamicImports.some((specifier) => specifier === undefined)) {
    fail(contract, `${relative(root, file)} contains a non-static dynamic import target`);
  }
}

function checkScannerFixtures() {
  const fixtures = [
    {
      name: "compact static imports and exports",
      code: 'import"node:path";export*from"node:fs";export{readFile}from"node:fs/promises";',
      specifiers: ["node:path", "node:fs", "node:fs/promises"],
      dynamicImports: [],
      processAccess: false,
    },
    {
      name: "static dynamic imports",
      code: 'void import("node:fs"); void import(`./chunk.js`);',
      specifiers: ["node:fs", "./chunk.js"],
      dynamicImports: ["node:fs", "./chunk.js"],
      processAccess: false,
    },
    {
      name: "TS import types",
      code: 'type NodeStats = import("node:fs").Stats; type Sdk = import(`tiny-agentic-sdk/client`); type Ui = import("tiny-agentic-ui/view");',
      specifiers: ["node:fs", "tiny-agentic-sdk/client", "tiny-agentic-ui/view"],
      dynamicImports: ["node:fs", "tiny-agentic-sdk/client", "tiny-agentic-ui/view"],
      processAccess: false,
    },
    {
      name: "non-static dynamic import",
      code: "declare const target: string; void import(target);",
      specifiers: [],
      dynamicImports: [undefined],
      processAccess: false,
    },
    {
      name: "comments strings and object process",
      code: '// import "node:path"; process.cwd()\nconst text = "globalThis.process and export * from node:fs";\nvoid text; void object.process; void object["process"]; void ({ process: 1 });',
      specifiers: [],
      dynamicImports: [],
      processAccess: false,
    },
    {
      name: "shadowed process",
      code: "function local(process: { cwd(): string }) { return process.cwd(); } const process = { cwd: () => '.' }; void process.cwd(); void local;",
      specifiers: [],
      dynamicImports: [],
      processAccess: false,
    },
    {
      name: "wrapped and computed global process",
      code: "void globalThis!.process; void globalThis[`process`]; void global.process; void process;",
      specifiers: [],
      dynamicImports: [],
      processAccess: true,
    },
    {
      name: "destructured globalThis process",
      code: "const { process: hostProcess } = (globalThis as typeof globalThis)!; void hostProcess;",
      specifiers: [],
      dynamicImports: [],
      processAccess: true,
    },
    {
      name: "destructured global process",
      code: "const { ['process']: hostProcess } = global; void hostProcess;",
      specifiers: [],
      dynamicImports: [],
      processAccess: true,
    },
    {
      name: "shadowed destructured globalThis process",
      code: "const globalThis = { process: 1 }; const { process: localProcess } = globalThis; void localProcess;",
      specifiers: [],
      dynamicImports: [],
      processAccess: false,
    },
    {
      name: "shadowed destructured global process",
      code: "function local(global: { process: number }) { const { process: localProcess } = global; return localProcess; } void local;",
      specifiers: [],
      dynamicImports: [],
      processAccess: false,
    },
  ];

  for (const fixture of fixtures) {
    const file = join(coreSource, "__boundary_fixtures__", `${fixture.name.replaceAll(" ", "-")}.ts`);
    const analysis = analyzeSource(fixture.code, file);
    if (fixture.name === "non-static dynamic import") {
      try {
        rejectNonStaticDynamicImports(analysis, "boundary scanner fixture", file);
        fail("boundary scanner fixtures", "non-static dynamic import fixture did not fail closed");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("boundary scanner fixture failed:")) throw error;
      }
    }
    if (
      analysis.processAccess !== fixture.processAccess
      || analysis.specifiers.length !== fixture.specifiers.length
      || analysis.specifiers.some((specifier, index) => specifier !== fixture.specifiers[index])
      || analysis.dynamicImports.length !== fixture.dynamicImports.length
      || analysis.dynamicImports.some((specifier, index) => specifier !== fixture.dynamicImports[index])
    ) {
      fail(
        "boundary scanner fixtures",
        `'${fixture.name}' produced ${JSON.stringify(analysis)}; expected ${JSON.stringify({ specifiers: fixture.specifiers, dynamicImports: fixture.dynamicImports, processAccess: fixture.processAccess })}`,
      );
    }
  }

  return fixtures.length;
}

async function checkBuiltinSources() {
  const files = await listFiles(builtinSource, ".ts");
  if (files.length === 0) fail("PT-11", `no TypeScript files found under ${builtinSource}`);

  for (const file of files) {
    if (allowlistedSources.has(file)) fail("PT-11", `tool source unexpectedly appears in allowlist: ${file}`);
    const source = await readFile(file, "utf8");
    const analysis = analyzeSource(source, file);
    rejectNonStaticDynamicImports(analysis, "PT-11", file);
    for (const specifier of analysis.specifiers) {
      if (forbiddenEnvironmentImport(specifier)) {
        fail("PT-11", `${relative(root, file)} imports forbidden environment module '${specifier}'`);
      }
    }
    if (analysis.processAccess) fail("PT-11", `${relative(root, file)} contains forbidden process access`);
  }

  return files.length;
}

async function resolveRelativeJavaScript(fromFile, specifier) {
  const path = resolve(dirname(fromFile), specifier);
  if (path !== dist && !path.startsWith(`${dist}${sep}`)) {
    fail("PT-10", `${relative(root, fromFile)} escapes dist through '${specifier}'`);
  }
  const candidates = extname(path) === "" ? [`${path}.js`, join(path, "index.js")] : [path];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next supported JavaScript resolution shape.
    }
  }
  fail("PT-10", `${relative(root, fromFile)} references missing relative module '${specifier}'`);
}

async function checkMainBundleGraph() {
  await requireFile(mainEntry, "PT-10", "Run `pnpm build` before this boundary check.");
  await requireFile(nodeEntry, "PT-10", "Run `pnpm build` before this boundary check.");

  const pending = [mainEntry];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);

    const source = await readFile(file, "utf8");
    const analysis = analyzeSource(source, file);
    rejectNonStaticDynamicImports(analysis, "PT-10", file);
    if (analysis.processAccess) {
      fail("PT-10", `${relative(root, file)} contains forbidden process access in main graph`);
    }

    for (const specifier of analysis.specifiers) {
      if (forbiddenEnvironmentImport(specifier)) {
        fail("PT-10", `${relative(root, file)} imports forbidden environment module '${specifier}'`);
      }
      if (specifier.startsWith(".")) pending.push(await resolveRelativeJavaScript(file, specifier));
    }
  }

  const nodeSource = await readFile(nodeEntry, "utf8");
  const nodeImports = analyzeSource(nodeSource, nodeEntry).specifiers;
  if (!nodeImports.some(forbiddenEnvironmentImport)) {
    fail("PT-10", `${relative(root, nodeEntry)} has no Node import; the allowed entry proof is not exercised`);
  }
  if (visited.has(nodeEntry)) {
    fail("PT-10", `${relative(root, nodeEntry)} is reachable from the portable main entry`);
  }

  return visited.size;
}

try {
  const lintFixtureCount = await checkLintContracts();
  const scannerFixtureCount = checkScannerFixtures();
  const builtinCount = await checkBuiltinSources();
  const graphCount = await checkMainBundleGraph();
  console.log(`PT-9 passed: ${lintFixtureCount} ESLint boundary fixtures verified.`);
  console.log(`Boundary scanner passed: ${scannerFixtureCount} parser fixtures verified.`);
  console.log(`PT-11 passed: ${builtinCount} model-facing built-in source files scanned.`);
  console.log(`PT-10 passed: ${graphCount} JavaScript files in the dist/index.js graph scanned.`);
  console.log("PT-10 passed: dist/platform/node.js remains a separate allowed Node entry.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
