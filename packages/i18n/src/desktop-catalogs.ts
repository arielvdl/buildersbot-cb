import { createCatalogs } from "./catalog-loader";
import { messages as enFormat } from "./messages/en/format";
import { en } from "./messages/en/index";
import { source as enSource } from "./messages/en/source";
import { messages as ptFormat } from "./messages/pt/format";
import { pt } from "./messages/pt/index";
import { source as ptSource } from "./messages/pt/source";

/**
 * The catalogs of the desktop renderer: `app-catalogs.ts`, `source-catalogs.ts`,
 * `format-catalogs.ts` and `locale-loading.ts` in one module, which `packages/i18n/vite-plugin.ts`
 * puts in their place for `electron.vite.config.ts`. The main process keeps every language.
 *
 * Each window is its own renderer process: the main window, a Dynamic Island for each display, the
 * browser dock, picture in picture, the chat windows and the Computer Use overlays. With all
 * thirteen languages each of them held about 8 MB of catalog source and the strings made from it,
 * of which it shows one language. A window cannot wait for a language before it renders: main sends
 * the first state when the page finishes loading, and a window that subscribes later misses it. So
 * English and Portuguese, the two languages of the interface text, are part of the bundle and draw
 * from the first frame. Each other language is a chunk that loads on first use, and a window shows
 * English until it loads.
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
