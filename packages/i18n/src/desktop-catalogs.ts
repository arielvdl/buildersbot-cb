import { addBundledLocale } from "./lazy-catalogs";
import { messages as ptFormat } from "./messages/pt/format";
import { pt } from "./messages/pt/index";
import { source as ptSource } from "./messages/pt/source";

/**
 * The catalogs of the desktop renderer: `lazy-catalogs.ts` with Portuguese in the bundle too.
 * `electron.vite.config.ts` puts this module in the place of `app-catalogs.ts`,
 * `source-catalogs.ts`, `format-catalogs.ts` and `locale-loading.ts`. The main process keeps
 * every language.
 *
 * Each window (the main window, a Dynamic Island on each display, the browser dock, picture in
 * picture and the chat windows) held all thirteen languages, about 8 MB of source. A window cannot
 * wait for a language before it renders: main sends the first state when the page finishes loading,
 * and a window that subscribes later misses it. So English and Portuguese, the two languages of the
 * interface text, are part of the bundle and draw from the first frame. Another language draws in
 * English until its chunk loads from the app bundle, and then changes.
 */
addBundledLocale("pt", { app: pt, source: ptSource, format: ptFormat });

export { appTranslation, formatTranslation, loadLocale, localeLoaded, sourceTranslation } from "./lazy-catalogs";
