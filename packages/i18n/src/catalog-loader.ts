import type { appTranslation as AppTranslation } from "./app-catalogs";
import type { formatTranslation as FormatTranslation } from "./format-catalogs";
import { TRANSLATED_LOCALES, type TranslatedLocale } from "./locale";
import type { loadLocale as LoadLocale, localeLoaded as LocaleLoaded } from "./locale-loading";
import type { sourceTranslation as SourceTranslation } from "./source-catalogs";

/** The three catalogs of one language. */
export interface LocaleCatalogs {
  app: NonNullable<ReturnType<typeof AppTranslation>>;
  source: NonNullable<ReturnType<typeof SourceTranslation>>;
  format: NonNullable<ReturnType<typeof FormatTranslation>>;
}

type LoadableLocale = Exclude<TranslatedLocale, "en">;

const loaders: Record<LoadableLocale, () => Promise<LocaleCatalogs>> = {
  de: () =>
    Promise.all([import("./messages/de/index"), import("./messages/de/source"), import("./messages/de/format")]).then(
      ([app, source, format]) => ({ app: app.de, source: source.source, format: format.messages }),
    ),
  es: () =>
    Promise.all([import("./messages/es/index"), import("./messages/es/source"), import("./messages/es/format")]).then(
      ([app, source, format]) => ({ app: app.es, source: source.source, format: format.messages }),
    ),
  fr: () =>
    Promise.all([import("./messages/fr/index"), import("./messages/fr/source"), import("./messages/fr/format")]).then(
      ([app, source, format]) => ({ app: app.fr, source: source.source, format: format.messages }),
    ),
  it: () =>
    Promise.all([import("./messages/it/index"), import("./messages/it/source"), import("./messages/it/format")]).then(
      ([app, source, format]) => ({ app: app.it, source: source.source, format: format.messages }),
    ),
  ja: () =>
    Promise.all([import("./messages/ja/index"), import("./messages/ja/source"), import("./messages/ja/format")]).then(
      ([app, source, format]) => ({ app: app.ja, source: source.source, format: format.messages }),
    ),
  ko: () =>
    Promise.all([import("./messages/ko/index"), import("./messages/ko/source"), import("./messages/ko/format")]).then(
      ([app, source, format]) => ({ app: app.ko, source: source.source, format: format.messages }),
    ),
  nl: () =>
    Promise.all([import("./messages/nl/index"), import("./messages/nl/source"), import("./messages/nl/format")]).then(
      ([app, source, format]) => ({ app: app.nl, source: source.source, format: format.messages }),
    ),
  pl: () =>
    Promise.all([import("./messages/pl/index"), import("./messages/pl/source"), import("./messages/pl/format")]).then(
      ([app, source, format]) => ({ app: app.pl, source: source.source, format: format.messages }),
    ),
  pt: () =>
    Promise.all([import("./messages/pt/index"), import("./messages/pt/source"), import("./messages/pt/format")]).then(
      ([app, source, format]) => ({ app: app.pt, source: source.source, format: format.messages }),
    ),
  ru: () =>
    Promise.all([import("./messages/ru/index"), import("./messages/ru/source"), import("./messages/ru/format")]).then(
      ([app, source, format]) => ({ app: app.ru, source: source.source, format: format.messages }),
    ),
  tr: () =>
    Promise.all([import("./messages/tr/index"), import("./messages/tr/source"), import("./messages/tr/format")]).then(
      ([app, source, format]) => ({ app: app.tr, source: source.source, format: format.messages }),
    ),
  zh: () =>
    Promise.all([import("./messages/zh/index"), import("./messages/zh/source"), import("./messages/zh/format")]).then(
      ([app, source, format]) => ({ app: app.zh, source: source.source, format: format.messages }),
    ),
};

/** The exports of `app-catalogs.ts`, `source-catalogs.ts`, `format-catalogs.ts` and `locale-loading.ts`. */
export interface Catalogs {
  appTranslation: typeof AppTranslation;
  sourceTranslation: typeof SourceTranslation;
  formatTranslation: typeof FormatTranslation;
  localeLoaded: typeof LocaleLoaded;
  loadLocale: typeof LoadLocale;
}

/**
 * The catalogs of a build that loads languages on first use. `lazy-catalogs.ts` (the public web
 * build) and `desktop-catalogs.ts` (the desktop renderer) each make one, with the languages that
 * their bundle holds from the start: `bundled`, of which English is always one. Every other
 * language is a chunk that loads on first use.
 */
export function createCatalogs(
  bundled: { en: LocaleCatalogs } & Partial<Record<LoadableLocale, LocaleCatalogs>>,
): Catalogs {
  const loaded = new Map<TranslatedLocale, LocaleCatalogs>();
  for (const locale of TRANSLATED_LOCALES) {
    const catalogs = locale === "en" ? bundled.en : bundled[locale];
    if (catalogs) loaded.set(locale, catalogs);
  }
  const loading = new Map<LoadableLocale, Promise<void>>();
  return {
    appTranslation: (locale) => loaded.get(locale)?.app,
    sourceTranslation: (locale) => loaded.get(locale)?.source,
    formatTranslation: (locale) => loaded.get(locale)?.format,
    localeLoaded: (locale) => loaded.has(locale),
    /** A failed load is not kept, so the next request for the language tries again. */
    loadLocale: (locale) => {
      if (locale === "en" || loaded.has(locale)) return Promise.resolve();
      const pending = loading.get(locale);
      if (pending) return pending;
      const next = loaders[locale]().then(
        (catalogs) => {
          loaded.set(locale, catalogs);
          loading.delete(locale);
        },
        (error: unknown) => {
          loading.delete(locale);
          throw error;
        },
      );
      loading.set(locale, next);
      return next;
    },
  };
}
