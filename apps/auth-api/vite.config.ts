import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig, type Plugin } from "vite";
import { lazyLanguageCatalogs } from "../../packages/i18n/vite-plugin";
import { contentImages } from "./content-images";
import { DEVELOPMENT_APNS_PATH, developmentApnsProxy } from "./dev-apns-proxy";
import { developmentNetworkRequestAllowed } from "./dev-network-access";
import { rendererPreviewAlias, rendererWebAlias } from "./renderer-preview-alias";
import { readLocalRuntimeVars } from "./src/server/runtime-env";

export default defineConfig(({ command }) => {
  const port = readApiPort(process.env.OPENBOT_API_PORT);
  const localRuntimeVars = command === "serve" ? readLocalRuntimeVars(process.env) : {};
  // The local Worker cannot reach Apple over HTTP/2, so it sends Live Activity updates to this server.
  if (localRuntimeVars.APNS_PRIVATE_KEY) {
    localRuntimeVars.APNS_ORIGIN = `http://127.0.0.1:${port}${DEVELOPMENT_APNS_PATH}`;
  }
  return {
    resolve: {
      dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
      alias: {
        "@openbot/renderer-preview": rendererPreviewAlias,
        "@openbot/renderer-web": rendererWebAlias,
      },
    },
    // Vite removes license comments by default. The home page beam's license requires its notice
    // in each copy, so the minifier moves `/*!` and `@license` comments to the end of each file.
    esbuild: { legalComments: "eof" },
    build: {
      // A caption file has to stay a file. It is small enough for Vite to fold
      // into the bundle as a `data:` URL, and a text track fetched from one is
      // cross-origin to the page that asks for it, so the player drops it and the
      // video plays with no captions at all. Everything else keeps the default.
      assetsInlineLimit: (file) => (file.endsWith(".vtt") ? false : undefined),
    },
    environments: {
      // Worker chunks import each other in cycles. Without strict order, a chunk can run before
      // the chunk that defines its imports, and every request fails with a 500.
      ssr: { build: { rolldownOptions: { output: { strictExecutionOrder: true } } } },
    },
    server: {
      host: readApiHost(process.env.OPENBOT_API_HOST),
      port,
      strictPort: true,
      // `bun run dev:slack` tunnels Slack's install return to this server.
      allowedHosts: [".openbot.localhost", ".trycloudflare.com"],
    },
    plugins: [
      developmentLanGuard(),
      developmentApnsProxy(),
      cloudflare({
        viteEnvironment: { name: "ssr" },
        config(config) {
          return { vars: { ...config.vars, ...localRuntimeVars } };
        },
      }),
      // The browser bundle loads each language other than English on first use (see
      // `packages/i18n/src/lazy-catalogs.ts`). The Worker keeps every language in its bundle.
      lazyLanguageCatalogs({
        source: fileURLToPath(new URL("../../packages/i18n/src/", import.meta.url)),
        replacement: "lazy-catalogs.ts",
        environment: "client",
      }),
      bloubServerBuild(),
      tanstackStart(),
      solidPlugin({ ssr: true }),
      // Lightning CSS currently reports valid named highlight selectors as
      // unsupported. Let Vite handle the final CSS bundle until that upstream
      // parser false positive is fixed.
      tailwindcss({ optimize: false }),
      contentImages(),
    ],
  };
});

function readApiPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3_100;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("OPENBOT_API_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}

function developmentLanGuard(): Plugin {
  return {
    name: "openbot-development-lan-guard",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (developmentNetworkRequestAllowed(request.socket.remoteAddress, request.url ?? "/")) {
          next();
          return;
        }
        response.statusCode = 404;
        response.end();
      });
    },
  };
}

const BLOUB_PACKAGE = "@norbert_bodziony/bloub";

/**
 * The Cloudflare plugin gives the Worker the `browser` export condition, which selects the DOM
 * build of bloub. That build calls `template()` when it loads, and the Solid server runtime throws
 * there, so every request failed with a 500. The Worker takes the server build instead.
 */
function bloubServerBuild(): Plugin {
  const serverEntry = fileURLToPath(import.meta.resolve(BLOUB_PACKAGE));
  return {
    name: "openbot-bloub-server-build",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "ssr",
    resolveId(source) {
      return source === BLOUB_PACKAGE ? serverEntry : null;
    },
  };
}

function readApiHost(value: string | undefined): "127.0.0.1" | "0.0.0.0" {
  if (value === undefined || value.trim() === "") return "127.0.0.1";
  if (value === "127.0.0.1" || value === "0.0.0.0") return value;
  throw new Error("OPENBOT_API_HOST must be 127.0.0.1 or 0.0.0.0.");
}
