import { createCatalogs } from "./catalog-loader";
import { messages as enFormat } from "./messages/en/format";
import { en } from "./messages/en/index";
import { source as enSource } from "./messages/en/source";

/**
 * The catalogs of the public web build: `app-catalogs.ts`, `source-catalogs.ts`,
 * `format-catalogs.ts` and `locale-loading.ts` in one module, which `apps/auth-api/vite.config.ts`
 * puts in their place.
 *
 * The site shows the desktop app as a demo and as the web client. All thirteen languages are more than
 * 1 MB compressed and block the page for about a second on a phone, so English is part of the
 * bundle and each other language is a chunk that loads on first use. Each export has the type of
 * the module it replaces, so the two builds cannot drift apart.
 */
const catalogs = createCatalogs({ en: { app: en, source: enSource, format: enFormat } });

export const appTranslation = catalogs.appTranslation;
export const sourceTranslation = catalogs.sourceTranslation;
export const formatTranslation = catalogs.formatTranslation;
export const localeLoaded = catalogs.localeLoaded;
export const loadLocale = catalogs.loadLocale;
