import { createCatalogs } from "./catalog-loader";
import { messages as enFormat } from "./messages/en/format";
import { en } from "./messages/en/index";
import { source as enSource } from "./messages/en/source";
import { messages as ptFormat } from "./messages/pt/format";
import { pt } from "./messages/pt/index";
import { source as ptSource } from "./messages/pt/source";

/**
 * The catalogs of the desktop renderer: `app-catalogs.ts`, `source-catalogs.ts`,
 * `format-catalogs.ts` and `locale-loading.ts` in one module, which `electron.vite.config.ts` puts
 * in their place. The main process keeps every language.
 *
 * Each window is its own renderer process: the main window, a Dynamic Island for each display, the
 * browser dock and the Computer Use overlays. With all thirteen languages each of them held about
 * 8 MB of catalog source and the strings made from it, of which it shows one language. English and
 * Portuguese are part of the bundle, so a window in either language shows it from the first frame.
 * Each other language is a chunk that loads on first use, and a window shows English until it loads.
 */
const catalogs = createCatalogs({
  en: { app: en, source: enSource, format: enFormat },
  pt: { app: pt, source: ptSource, format: ptFormat },
});

export const appTranslation = catalogs.appTranslation;
export const sourceTranslation = catalogs.sourceTranslation;
export const formatTranslation = catalogs.formatTranslation;
export const localeLoaded = catalogs.localeLoaded;
export const loadLocale = catalogs.loadLocale;
