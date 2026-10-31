import { normalizePath, type Plugin } from "vite";

const EAGER_CATALOG_MODULES = new Set(["./app-catalogs", "./source-catalogs", "./format-catalogs", "./locale-loading"]);

export interface LazyLanguageCatalogsOptions {
  /** The absolute path of `packages/i18n/src/`. */
  source: string;
  /**
   * The module that holds some languages in the bundle and loads each other one on first use:
   * `lazy-catalogs.ts` (English) for the public web build, `desktop-catalogs.ts` (English and
   * Portuguese) for the desktop renderer.
   */
  replacement: "lazy-catalogs.ts" | "desktop-catalogs.ts";
  /** The Vite environment that gets the replacement. The other environments keep every language. */
  environment: string;
}

/**
 * Puts `replacement` in the place of the four modules that hold every language
 * (`app-catalogs.ts`, `source-catalogs.ts`, `format-catalogs.ts` and `locale-loading.ts`), for the
 * imports from inside `@openbot/i18n`. Each language is more than 0.5 MB of source, and a bundle
 * with all thirteen keeps them in every page that loads it.
 */
export function lazyLanguageCatalogs(options: LazyLanguageCatalogsOptions): Plugin {
  return {
    name: "openbot-lazy-language-catalogs",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === options.environment,
    resolveId: (id, importer) => catalogReplacement(id, importer, options),
  };
}

/**
 * The path of the module that takes the place of `id` in `importer`, or null to keep `id`. Only an
 * import of one of the four catalog modules from a file under `source` changes.
 */
export function catalogReplacement(
  id: string,
  importer: string | undefined,
  options: Pick<LazyLanguageCatalogsOptions, "source" | "replacement">,
): string | null {
  if (!importer || !EAGER_CATALOG_MODULES.has(id)) return null;
  const source = normalizePath(options.source.endsWith("/") ? options.source : `${options.source}/`);
  if (!normalizePath(importer).startsWith(source)) return null;
  return `${source}${options.replacement}`;
}
