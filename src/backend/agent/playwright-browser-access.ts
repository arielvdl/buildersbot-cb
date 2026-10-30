import type { McpServerConfig } from "@openbot/contracts/ipc";

const PLAYWRIGHT_SERVER_NAME = "playwright";
const PLAYWRIGHT_PACKAGE = /@playwright\/mcp/u;
const GATED_LAUNCHER = /playwright-mcp-gated\.mjs$/u;
/** The token the Playwright extension shows after the first approval. Passed on when the app has it, so the approval is asked once. */
const EXTENSION_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";

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
 * changed here, on its way out: attached to the browser that is already open through the Playwright
 * extension, or left out when the Builders Bot browser is the way in. A row that the person edited into
 * something else is not touched.
 */
export function applyBrowserAccess(configs: readonly McpServerConfig[], browserInApp: boolean): McpServerConfig[] {
  return configs.flatMap((config) => {
    if (!isPlaywrightServer(config)) return [config];
    if (browserInApp) return [];
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
