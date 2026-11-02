// The table of engine functions that may run in the person's Chrome.
//
// The browser engine (`src/backend/browser-cdp*.ts`) runs page code only as fixed functions: through
// `Runtime.callFunctionOn`, in `#callOnNode` (with a user gesture), in `callInContext`, or at a
// `send("Runtime.callFunctionOn", ...)` with a constant declaration. Values go in `arguments`, never in
// the code. In the person's Chrome, the extension runs a function only when the SHA-256 of its
// declaration is in `packages/contracts/src/chrome-bridge/cdp-functions.ts`, and lets a gesture through
// only for the functions of `#callOnNode`. `Runtime.evaluate` is the agent's own code: only
// `BrowserCdp.evaluate` sends it, and in Chrome it waits for the person's scripts switch.
//
// This script reads the engine source, evaluates each declaration (literals, templates, `String.raw`,
// constants, `JSON.stringify` of constants and functions that return one), and writes the digests.
// It fails when a declaration is not a constant it can read, when the engine sends `Runtime.evaluate`
// outside `BrowserCdp.evaluate`, or when a gesture appears in a place it does not know.
//
// `bun scripts/chrome-bridge-cdp-functions.ts` writes the file. `--check` only compares, and fails when
// the file is stale. Writes .buildersbot-build/chrome-bridge-cdp-functions/report.json.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BACKEND = join(ROOT, "src/backend");
const TABLE = join(ROOT, "packages/contracts/src/chrome-bridge/cdp-functions.ts");
const OUT = join(ROOT, ".buildersbot-build/chrome-bridge-cdp-functions");
/** The `Effect.fn` names where the engine sends `userGesture: true` today. */
const KNOWN_GESTURE_SITES = new Set(["BrowserCdp.callOnNode", "BrowserCdp.evaluate"]);
/** The one place that sends the agent's own code. */
const AGENT_CODE_SITES = new Set(["BrowserCdp.evaluate"]);
/** Helpers that forward a declaration that their callers give; the callers' declarations are read. */
const FORWARDING_HELPERS = new Set(["BrowserCdp.callOnNode", "callInContext"]);
/** Calls whose third argument is a declaration: `this.#callOnNode(send, node, declaration, ...)`. */
const GESTURE_CALLS = new Set(["#callOnNode"]);
const PLAIN_CALLS = new Set(["callInContext"]);

// TypeScript 7 has no JavaScript compiler API. The TypeScript 6 API comes with the Storybook tool chain.
type TypeScript = typeof import("@typescript/typescript6");
function loadTypeScript(): TypeScript {
  try {
    return createRequire(join(ROOT, "package.json"))("@typescript/typescript6");
  } catch {
    throw new Error("The TypeScript 6 compiler API (@typescript/typescript6) is not installed. Run bun install.");
  }
}

const ts = loadTypeScript();
const check = process.argv.includes("--check");

const engineFiles = (await readdir(BACKEND))
  .filter((name) => /^(browser|chrome)-.*\.ts$/u.test(name) && !name.endsWith(".test.ts"))
  .map((name) => join(BACKEND, name))
  .sort();
const program = ts.createProgram(engineFiles, {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  noResolve: false,
  types: [],
});
const checker = program.getTypeChecker();

function where(node: import("@typescript/typescript6").Node): string {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart());
  return `${relative(ROOT, source.fileName)}:${line + 1}`;
}

function evaluate(node: import("@typescript/typescript6").Node): string | number {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return evaluate(node.expression);
  if (ts.isTemplateExpression(node))
    return node.templateSpans.reduce(
      (text, span) => `${text}${String(evaluate(span.expression))}${span.literal.text}`,
      node.head.text,
    );
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === "String.raw") {
    const template = node.template;
    if (ts.isNoSubstitutionTemplateLiteral(template)) return template.rawText ?? template.text;
    return template.templateSpans.reduce(
      (text, span) => `${text}${String(evaluate(span.expression))}${span.literal.rawText ?? span.literal.text}`,
      template.head.rawText ?? template.head.text,
    );
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    return typeof left === "number" && typeof right === "number" ? left + right : `${left}${right}`;
  }
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
    )
      return evaluate(declaration.initializer);
    throw new Error(`${where(node)}: ${node.text} is not a constant this script can read.`);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    const [argument] = node.arguments;
    if (callee === "JSON.stringify" && argument && node.arguments.length === 1)
      return JSON.stringify(evaluate(argument));
    if (ts.isIdentifier(node.expression) && node.arguments.length === 0) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declaration = symbol?.valueDeclaration;
      const statement = declaration && ts.isFunctionDeclaration(declaration) ? declaration.body?.statements : undefined;
      const only = statement?.length === 1 ? statement[0] : undefined;
      if (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.parameters.length === 0 &&
        only &&
        ts.isReturnStatement(only) &&
        only.expression
      )
        return evaluate(only.expression);
    }
  }
  throw new Error(`${where(node)}: this script cannot evaluate \`${node.getText().slice(0, 80)}\`.`);
}

/** The name of the `Effect.fn` that holds a node, such as `BrowserCdp.callOnNode`, or of its function. */
function enclosingEffectName(node: import("@typescript/typescript6").Node): string | null {
  for (let current: import("@typescript/typescript6").Node | undefined = node; current; current = current.parent) {
    // `Effect.fn("Name")(function* () { ... })`: the node sits in the outer call.
    const named = ts.isCallExpression(current) && ts.isCallExpression(current.expression) ? current.expression : null;
    const name = named?.arguments[0];
    if (named && named.expression.getText() === "Effect.fn" && name && ts.isStringLiteral(name)) return name.text;
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  }
  return null;
}

/** Whether an identifier names a parameter of the function that holds it. */
function isParameter(node: import("@typescript/typescript6").Node): boolean {
  const symbol = ts.isShorthandPropertyAssignment(node)
    ? checker.getShorthandAssignmentValueSymbol(node)
    : checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration;
  return declaration !== undefined && ts.isParameter(declaration);
}

const declarations = new Map<string, { digest: string; gesture: boolean; sites: string[] }>();
const gestureSites: { site: string; effect: string | null }[] = [];
const problems: string[] = [];

function addDeclaration(node: import("@typescript/typescript6").Node, gesture: boolean): void {
  let value: string | number;
  try {
    value = evaluate(node);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return;
  }
  if (typeof value !== "string") {
    problems.push(`${where(node)}: the declaration is not a string.`);
    return;
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const entry = declarations.get(digest) ?? { digest, gesture: false, sites: [] };
  entry.gesture ||= gesture;
  entry.sites.push(where(node));
  declarations.set(digest, entry);
}

const calleeName = (node: import("@typescript/typescript6").CallExpression): string =>
  ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : node.expression.getText();

function visit(node: import("@typescript/typescript6").Node): void {
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node);
    if (GESTURE_CALLS.has(callee) || PLAIN_CALLS.has(callee)) {
      const declaration = node.arguments[2];
      if (!declaration) problems.push(`${where(node)}: ${callee} without a declaration.`);
      else addDeclaration(declaration, GESTURE_CALLS.has(callee));
    }
    const [method, params] = node.arguments;
    const methodName = method && ts.isStringLiteral(method) ? method.text : null;
    if (methodName === "Runtime.evaluate" && !AGENT_CODE_SITES.has(enclosingEffectName(node) ?? ""))
      problems.push(
        `${where(node)}: the engine sends Runtime.evaluate outside BrowserCdp.evaluate. Run a fixed function with callInContext.`,
      );
    if (methodName === "Runtime.callFunctionOn") {
      const property =
        params && ts.isObjectLiteralExpression(params)
          ? params.properties.find((entry) => entry.name?.getText() === "functionDeclaration")
          : undefined;
      if (!property || !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
        problems.push(
          `${where(node)}: Runtime.callFunctionOn without a functionDeclaration that this script can read.`,
        );
      else if (ts.isShorthandPropertyAssignment(property) || isParameter(property.initializer)) {
        // A helper that forwards its caller's declaration: the callers are read instead.
        const helper = enclosingEffectName(node);
        if (!FORWARDING_HELPERS.has(helper ?? ""))
          problems.push(
            `${where(node)}: ${helper ?? "a function"} forwards a declaration that this script does not read.`,
          );
      } else addDeclaration(property.initializer, false);
    }
  }
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === "userGesture" &&
    node.initializer.kind === ts.SyntaxKind.TrueKeyword
  )
    gestureSites.push({ site: where(node), effect: enclosingEffectName(node) });
  ts.forEachChild(node, visit);
}
for (const file of engineFiles) {
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`Cannot read ${file}.`);
  visit(source);
}

const digests = [...declarations.keys()].sort();
const gestureDigests = digests.filter((digest) => declarations.get(digest)?.gesture === true);
const table = `// Generated by scripts/chrome-bridge-cdp-functions.ts from src/backend/browser-*.ts. Do not edit.
// Run \`bun scripts/chrome-bridge-cdp-functions.ts\` after a change to a function that the engine runs.

/**
 * The SHA-256 digests, in lower-case hex, of every function that the browser engine runs in a page
 * through \`Runtime.callFunctionOn\`. In the person's Chrome, the extension runs only these
 * declarations, unless the person turned on the agent's own scripts for the project.
 */
export const ENGINE_FUNCTION_DIGESTS: readonly string[] = [
${digests.map((digest) => `  "${digest}",`).join("\n")}
];

/**
 * The engine functions that run with \`userGesture: true\` (\`#callOnNode\`). In the person's Chrome,
 * the extension lets a gesture through only for these declarations; an agent's own script runs
 * through \`script.run\`, with no gesture.
 */
export const ENGINE_GESTURE_FUNCTION_DIGESTS: readonly string[] = [
${gestureDigests.map((digest) => `  "${digest}",`).join("\n")}
];

export const ENGINE_FUNCTIONS: ReadonlySet<string> = new Set(ENGINE_FUNCTION_DIGESTS);
export const ENGINE_GESTURE_FUNCTIONS: ReadonlySet<string> = new Set(ENGINE_GESTURE_FUNCTION_DIGESTS);
`;

const unknownSites = gestureSites.filter((entry) => entry.effect === null || !KNOWN_GESTURE_SITES.has(entry.effect));
let current = "";
try {
  current = await readFile(TABLE, "utf8");
} catch {
  current = "";
}
const stale = current !== table;
if (!check && stale && problems.length === 0) await writeFile(TABLE, table);

const passed = unknownSites.length === 0 && problems.length === 0 && (!check || !stale);
await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, "report.json"),
  `${JSON.stringify(
    {
      passed,
      mode: check ? "check" : "write",
      functions: digests.length,
      gestureFunctions: gestureDigests.length,
      files: engineFiles.map((file) => relative(ROOT, file)),
      problems,
      callSites: [...declarations.values()].reduce((count, entry) => count + entry.sites.length, 0),
      stale,
      gestureSites,
      unknownSites,
      declarations: [...declarations.values()].sort((a, b) => a.digest.localeCompare(b.digest)),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `${passed ? "PASSED" : "FAILED"}: ${digests.length} functions (${gestureDigests.length} with a gesture), ${unknownSites.length} unknown gesture sites, ${problems.length} problems${check && stale ? ", table is stale" : ""}. ${join(OUT, "report.json")}\n${problems.map((problem) => `  ${problem}\n`).join("")}`,
);
if (!passed) process.exitCode = 1;
