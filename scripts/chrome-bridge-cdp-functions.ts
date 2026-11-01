// The table of engine functions that may run with a user gesture in the person's Chrome.
//
// The browser engine (`src/backend/browser-cdp.ts`) runs its element functions through
// `Runtime.callFunctionOn` with `userGesture: true`, in `#callOnNode`. In Chrome, the extension lets a
// command through with a gesture only when the SHA-256 of its `functionDeclaration` is in
// `packages/contracts/src/chrome-bridge/cdp-functions.ts`: an agent's own code never gets one. This
// script reads the engine source, evaluates each declaration that `#callOnNode` receives (literals,
// templates, `String.raw`, constants, `JSON.stringify` of constants and functions that return one), and
// writes the digests.
//
// `bun scripts/chrome-bridge-cdp-functions.ts` writes the file. `--check` only compares, and fails when
// the file is stale or when a gesture appears in a place this script does not know. Writes
// .buildersbot-build/chrome-bridge-cdp-functions/report.json.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE = join(ROOT, "src/backend/browser-cdp.ts");
const TABLE = join(ROOT, "packages/contracts/src/chrome-bridge/cdp-functions.ts");
const OUT = join(ROOT, ".buildersbot-build/chrome-bridge-cdp-functions");
/** The `Effect.fn` names where the engine sends `userGesture: true` today. */
const KNOWN_GESTURE_SITES = new Set(["BrowserCdp.callOnNode", "BrowserCdp.evaluate"]);

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

const program = ts.createProgram([ENGINE], {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  noResolve: false,
  types: [],
});
const checker = program.getTypeChecker();
const engineSource = program.getSourceFile(ENGINE);
if (!engineSource) throw new Error(`Cannot read ${ENGINE}.`);

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

/** The name of the `Effect.fn` that holds a node, such as `BrowserCdp.callOnNode`. */
function enclosingEffectName(node: import("@typescript/typescript6").Node): string | null {
  for (let current: import("@typescript/typescript6").Node | undefined = node; current; current = current.parent) {
    // `Effect.fn("Name")(function* () { ... })`: the node sits in the outer call.
    const named = ts.isCallExpression(current) && ts.isCallExpression(current.expression) ? current.expression : null;
    const name = named?.arguments[0];
    if (named && named.expression.getText() === "Effect.fn" && name && ts.isStringLiteral(name)) return name.text;
  }
  return null;
}

const declarations = new Map<string, { digest: string; sites: string[] }>();
const gestureSites: { site: string; effect: string | null }[] = [];

function visit(node: import("@typescript/typescript6").Node): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.getText() === "#callOnNode"
  ) {
    const declaration = node.arguments[2];
    if (!declaration) throw new Error(`${where(node)}: #callOnNode without a declaration.`);
    const value = evaluate(declaration);
    if (typeof value !== "string") throw new Error(`${where(node)}: the declaration is not a string.`);
    const digest = createHash("sha256").update(value, "utf8").digest("hex");
    const entry = declarations.get(digest) ?? { digest, sites: [] };
    entry.sites.push(where(node));
    declarations.set(digest, entry);
  }
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === "userGesture" &&
    node.initializer.kind === ts.SyntaxKind.TrueKeyword
  )
    gestureSites.push({ site: where(node), effect: enclosingEffectName(node) });
  ts.forEachChild(node, visit);
}
visit(engineSource);

const digests = [...declarations.keys()].sort();
const table = `// Generated by scripts/chrome-bridge-cdp-functions.ts from src/backend/browser-cdp.ts. Do not edit.
// Run \`bun scripts/chrome-bridge-cdp-functions.ts\` after a change to a function that \`#callOnNode\` runs.

/**
 * The SHA-256 digests, in lower-case hex, of the engine functions that run through
 * \`Runtime.callFunctionOn\` with \`userGesture: true\`. In the person's Chrome, the extension lets a
 * gesture through only for these declarations; an agent's own script runs through \`script.run\`, with
 * no gesture.
 */
export const ENGINE_GESTURE_FUNCTION_DIGESTS: readonly string[] = [
${digests.map((digest) => `  "${digest}",`).join("\n")}
];

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
if (!check && stale) await writeFile(TABLE, table);

const passed = unknownSites.length === 0 && (!check || !stale);
await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, "report.json"),
  `${JSON.stringify(
    {
      passed,
      mode: check ? "check" : "write",
      functions: digests.length,
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
  `${passed ? "PASSED" : "FAILED"}: ${digests.length} functions, ${unknownSites.length} unknown gesture sites${check && stale ? ", table is stale" : ""}. ${join(OUT, "report.json")}\n`,
);
if (!passed) process.exitCode = 1;
