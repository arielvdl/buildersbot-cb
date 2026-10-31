import type { McpServerConfig } from "@openbot/contracts/ipc";

const PLAYWRIGHT_SERVER_NAME = "playwright";
const PLAYWRIGHT_PACKAGE = /@playwright\/mcp/u;
const GATED_LAUNCHER = /playwright-mcp-gated\.mjs$/u;
/** The token the Playwright extension shows after the first approval. Passed on when the app has it, so the approval is asked once. */
const EXTENSION_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
/** The program the Playwright package installs. A global install puts it on the path. */
const PLAYWRIGHT_PROGRAM = "playwright-mcp";
/** Pinned: `npx` runs code from the network, so it never runs a version that nobody chose. */
const PLAYWRIGHT_PINNED_PACKAGE = "@playwright/mcp@0.0.83";

/**
 * The id of the Playwright server as the providers are given it when the browser broker serves it.
 * The gateway reads it to add the broker's bearer at the hand-off, so the bearer is never in the row.
 */
export const BROWSER_BROKER_MCP_SERVER_ID = "builders-bot-browser-broker";

/** Where the broker listens, as the hand-off needs it. The bearer is added by the gateway. */
export interface BrowserBrokerAddress {
  url: string;
  bearer: string;
}

function isPlaywrightServer(config: McpServerConfig): boolean {
  if (config.transport !== "stdio" || config.name !== PLAYWRIGHT_SERVER_NAME) return false;
  return (
    PLAYWRIGHT_PACKAGE.test([config.command, ...config.args].join(" ")) ||
    config.args.some((arg) => GATED_LAUNCHER.test(arg))
  );
}

/**
 * What the providers are given for the Playwright server, by where the person wants web access.
 *
 * The stored row is the one the Marketplace saved, which starts its own Chrome for each session; a few
 * sessions at once is what exhausts the memory of the computer. So the row is read as it was saved and
 * changed here, on its way out:
 *
 * - With the browser broker, one http server that all agents share. The broker holds the only
 *   Playwright process, and it attaches to the browser that is already open through the extension.
 * - Without it, the row attached to that browser through the extension, one process for each agent.
 * - With the Builders Bot browser as the way in, no Playwright at all.
 *
 * A row that the person edited into something else is not touched.
 */
export function applyBrowserAccess(
  configs: readonly McpServerConfig[],
  browserInApp: boolean,
  broker: BrowserBrokerAddress | null = null,
): McpServerConfig[] {
  return configs.flatMap((config) => {
    if (!isPlaywrightServer(config)) return [config];
    if (browserInApp) return [];
    if (broker) {
      return [
        {
          id: BROWSER_BROKER_MCP_SERVER_ID,
          name: config.name,
          transport: "http",
          enabled: true,
          command: "",
          args: [],
          env: [],
          envPassthrough: [],
          workingDirectory: "",
          url: broker.url,
          headers: [],
        },
      ];
    }
    const gated = config.args.some((arg) => GATED_LAUNCHER.test(arg));
    const attached = gated ? config.args.includes("user") : config.args.includes("--extension");
    return [
      {
        ...config,
        args: attached ? config.args : gated ? [...config.args, "--mode", "user"] : [...config.args, "--extension"],
        envPassthrough: config.envPassthrough.includes(EXTENSION_TOKEN_ENV)
          ? config.envPassthrough
          : [...config.envPassthrough, EXTENSION_TOKEN_ENV],
      },
    ];
  });
}

/** How the broker starts the one Playwright server: a program, its arguments, and the environment it gets. */
export interface PlaywrightUpstream {
  command: string;
  args: string[];
  /** Variables the row sets itself. */
  env: Record<string, string>;
  /** Names of variables copied from the app's own environment. Nothing else of it reaches the child. */
  passthrough: string[];
}

/** The variables a browser tool needs from the app, before the row names more. No key or token of a provider is here. */
const BASE_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "PLAYWRIGHT_BROWSERS_PATH",
  EXTENSION_TOKEN_ENV,
];

/**
 * The browser of the server while the egress proxy is on: a profile folder of its own, and the
 * `@playwright/mcp` configuration file that holds `browser.launchOptions.proxy`.
 */
export interface PlaywrightEgressLaunch {
  userDataDir: string;
  configPath: string;
}

/** The flags that start a browser of its own, or move or label the server. The broker sets its own. */
const VALUE_FLAGS = new Set(["--port", "--host", "--mode", "--cdp-endpoint", "--user-data-dir", "--allowed-hosts"]);
const BARE_FLAGS = new Set(["--extension", "--isolated", "--headless", "--shared-browser-context"]);

function ownFlags(args: readonly string[], ownConfig: boolean): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const name = arg.split("=")[0] ?? arg;
    if (BARE_FLAGS.has(name)) continue;
    if (VALUE_FLAGS.has(name) || (ownConfig && name === "--config")) {
      // `--port 9` takes the next argument with it; `--port=9` is one argument.
      if (!arg.includes("=")) index += 1;
      continue;
    }
    kept.push(arg);
  }
  return kept;
}

/**
 * The one Playwright server the broker runs, from the row the person saved, or null when there is no
 * such enabled row. It always attaches to the browser that is open (`--extension`), shares one context
 * between agents, listens on a free loopback port, and starts no browser.
 *
 * `findProgram` answers where a program is installed. The gated launcher is a wrapper that leases a
 * browser of its own, which the broker replaces, so it is left out and the program it wraps is run.
 */
export function playwrightUpstream(
  configs: readonly McpServerConfig[],
  findProgram: (name: string) => string | null,
  egress?: PlaywrightEgressLaunch,
): PlaywrightUpstream | null {
  const row = configs.find((config) => config.enabled && isPlaywrightServer(config));
  if (!row) return null;
  const gated = row.args.some((arg) => GATED_LAUNCHER.test(arg));
  // One pass over the arguments, in order: the package and its own options stay, and a flag that the
  // broker sets itself goes with its value.
  const kept = ownFlags(
    row.args.filter((arg) => !GATED_LAUNCHER.test(arg)),
    egress !== undefined,
  );
  // With the egress proxy on, the person's Chrome cannot use the server's proxy, so the server starts
  // a browser of its own, with its own profile and the proxy in the configuration file.
  const serverFlags = egress
    ? ["--user-data-dir", egress.userDataDir, "--config", egress.configPath, "--shared-browser-context"]
    : ["--extension", "--shared-browser-context"];
  const place = ["--port", "0", "--host", "127.0.0.1"];
  const env = Object.fromEntries(row.env.map((pair) => [pair.key, pair.value]));
  const passthrough = [...new Set([...BASE_PASSTHROUGH, ...row.envPassthrough])];
  // The package form keeps its own command (`npx`, `bunx`) and package argument.
  if (!gated) return { command: row.command, args: [...kept, ...serverFlags, ...place], env, passthrough };
  const program = findProgram(PLAYWRIGHT_PROGRAM);
  if (program) return { command: program, args: [...kept, ...serverFlags, ...place], env, passthrough };
  return {
    command: "npx",
    args: ["-y", PLAYWRIGHT_PINNED_PACKAGE, ...kept, ...serverFlags, ...place],
    env,
    passthrough,
  };
}
