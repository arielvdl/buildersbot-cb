/**
 * The Icon and Emoji tabs of the section icon editor. Each one has a search field that has the focus
 * when the tab opens, category buttons, the recent choices, and a grid. The grid is a listbox: the
 * arrow keys move in rows of eight, Home and End go to the ends, and Enter or Space picks. The grid
 * renders the first rows and adds more while it scrolls or while the keys move past them, so a list of
 * hundreds of items stays fast.
 *
 * The lists load with `import()` (`section-icon-assets.ts`). The editor stores only a glyph name of a
 * fixed table or one emoji, never markup.
 */

import type { SidebarSectionGlyph } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, Search } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, flush, Match, onSettled, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { isSidebarSectionBuiltinGlyph, SectionGlyphIcon, SIDEBAR_SECTION_GLYPH_LABELS } from "./SidebarSectionMark";
import {
  loadSectionEmojiList,
  loadSectionIconLibrary,
  sectionEmojiList,
  sectionEmojiListState,
  sectionIconLibrary,
  sectionIconLibraryState,
} from "./section-icon-assets";
import { sectionEmojiTone, sectionIconRecents, setSectionEmojiTone } from "./section-icon-recents";
import {
  SECTION_EMOJI_CATEGORIES,
  SECTION_EMOJI_TONES,
  SECTION_ICON_CATEGORIES,
  type SectionEmojiCategory,
  type SectionEmojiEntry,
  type SectionEmojiTone,
  type SectionIconCategory,
  type SectionIconEntry,
  searchSectionPicker,
  sectionEmojiWithTone,
} from "./section-icon-search";

/** The columns of the grid. `sidebar-section-rail.css` draws the same number. */
const COLUMNS = 8;
/** The items that the grid renders first, and adds at a time. */
const BATCH = COLUMNS * 12;

const ICON_CATEGORY_LABELS = {
  general: "sidebar.sectionIcon.category.general",
  code: "sidebar.sectionIcon.category.code",
  communication: "sidebar.sectionIcon.category.communication",
  data: "sidebar.sectionIcon.category.data",
  people: "sidebar.sectionIcon.category.people",
  objects: "sidebar.sectionIcon.category.objects",
  nature: "sidebar.sectionIcon.category.nature",
  food: "sidebar.sectionIcon.category.food",
  media: "sidebar.sectionIcon.category.media",
  business: "sidebar.sectionIcon.category.business",
  travel: "sidebar.sectionIcon.category.travel",
} as const satisfies Record<SectionIconCategory, AppTextKey>;

const EMOJI_CATEGORY_LABELS = {
  faces: "sidebar.sectionIcon.emojiCategory.faces",
  people: "sidebar.sectionIcon.emojiCategory.people",
  animals: "sidebar.sectionIcon.emojiCategory.animals",
  food: "sidebar.sectionIcon.emojiCategory.food",
  travel: "sidebar.sectionIcon.emojiCategory.travel",
  activities: "sidebar.sectionIcon.emojiCategory.activities",
  objects: "sidebar.sectionIcon.emojiCategory.objects",
  symbols: "sidebar.sectionIcon.emojiCategory.symbols",
  flags: "sidebar.sectionIcon.emojiCategory.flags",
} as const satisfies Record<SectionEmojiCategory, AppTextKey>;

/** The emoji on each category button. */
const EMOJI_CATEGORY_MARKS = {
  faces: "😀",
  people: "👋",
  animals: "🐶",
  food: "🍔",
  travel: "✈️",
  activities: "⚽",
  objects: "💡",
  symbols: "❤️",
  flags: "🏁",
} as const satisfies Record<SectionEmojiCategory, string>;

const TONE_LABELS = {
  0: "sidebar.sectionIcon.skinTone.default",
  1: "sidebar.sectionIcon.skinTone.light",
  2: "sidebar.sectionIcon.skinTone.mediumLight",
  3: "sidebar.sectionIcon.skinTone.medium",
  4: "sidebar.sectionIcon.skinTone.mediumDark",
  5: "sidebar.sectionIcon.skinTone.dark",
} as const satisfies Record<SectionEmojiTone, AppTextKey>;

/** What the search field asks of the grid below it. */
interface PickerGridHandle {
  focusFirst: () => void;
  pickFirst: () => void;
}

function PickerGrid<T>(props: {
  label: string;
  items: readonly T[];
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  renderItem: (item: T) => JSX.Element;
  selectedKey: string | null;
  onPick: (item: T) => void;
  /** Up from the first row: the focus goes back to the search field. */
  onLeaveTop?: () => void;
  handle?: (handle: PickerGridHandle) => void;
  class?: string;
}) {
  let list: HTMLDivElement | undefined;
  const [count, setCount] = createSignal(BATCH);
  const [active, setActive] = createSignal(0);
  const shown = createMemo(() => props.items.slice(0, count()));

  // A new list starts at its first rows, with the selected item active when the list has it.
  createEffect(
    () => props.items,
    (items) => {
      const selected = items.findIndex((item) => props.itemKey(item) === props.selectedKey);
      setActive(Math.max(0, selected));
      setCount(Math.max(BATCH, Math.ceil((selected + 1) / BATCH) * BATCH));
      if (list) list.scrollTop = 0;
    },
  );

  function focusIndex(index: number): void {
    const target = Math.min(Math.max(index, 0), props.items.length - 1);
    if (target < 0) return;
    if (target >= count()) setCount(Math.ceil((target + 1) / BATCH) * BATCH);
    setActive(target);
    flush();
    list?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus();
  }

  props.handle?.({
    focusFirst: () => focusIndex(active()),
    pickFirst: () => {
      const first = props.items[0];
      if (first) props.onPick(first);
    },
  });

  const moves: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -COLUMNS,
    ArrowDown: COLUMNS,
    PageUp: -COLUMNS * 4,
    PageDown: COLUMNS * 4,
  };

  function keyDown(event: KeyboardEvent): void {
    const current = active();
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      if (event.key === "ArrowUp" && current < COLUMNS && props.onLeaveTop) props.onLeaveTop();
      else focusIndex(current + move);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusIndex(event.key === "Home" ? 0 : props.items.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = props.items[current];
      if (item) props.onPick(item);
    }
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label={props.label}
      class={["section-picker-grid", props.class]}
      onKeyDown={keyDown}
      onClick={(event) => {
        // One handler for the list: the keys of the options are handled here too.
        const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null;
        const index = Number(option?.dataset.index);
        const item = props.items[index];
        if (!option || item === undefined) return;
        setActive(index);
        props.onPick(item);
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (count() >= props.items.length) return;
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 120) setCount((value) => value + BATCH);
      }}
    >
      <For each={shown()}>
        {(item, index) => (
          <button
            type="button"
            role="option"
            class="section-picker-item"
            data-index={index()}
            aria-label={props.itemLabel(item)}
            aria-selected={props.itemKey(item) === props.selectedKey ? "true" : "false"}
            aria-setsize={props.items.length}
            aria-posinset={index() + 1}
            tabindex={index() === active() ? 0 : -1}
            title={props.itemLabel(item)}
            onFocus={() => setActive(index())}
          >
            {props.renderItem(item)}
          </button>
        )}
      </For>
    </div>
  );
}

/** The search field of a picker. Down goes to the grid; Enter picks the first result. */
function PickerSearch(props: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  grid: () => PickerGridHandle | undefined;
  ref: (element: HTMLInputElement) => void;
  children?: JSX.Element;
}) {
  return (
    <div class="section-picker-search">
      <span class="section-picker-search-field">
        <Search class="section-picker-search-icon" aria-hidden="true" />
        <Input
          ref={props.ref}
          type="search"
          size="sm"
          class="section-picker-search-input"
          autocomplete="off"
          spellcheck={false}
          placeholder={props.label}
          aria-label={props.label}
          value={props.value}
          onValueChange={props.onValueChange}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              props.grid()?.focusFirst();
            } else if (event.key === "Enter") {
              // Enter in the search picks; it must not save the form with no choice yet.
              event.preventDefault();
              props.grid()?.pickFirst();
            }
          }}
        />
      </span>
      {props.children}
    </div>
  );
}

function PickerStatus(props: { state: string; onRetry: () => void }) {
  const { t } = useText();
  return (
    <Show
      when={props.state === "failed"}
      fallback={
        <p class="section-picker-status" aria-live="polite">
          {t("sidebar.sectionIcon.loading")}
        </p>
      }
    >
      <div class="section-picker-status" role="alert">
        <span>{t("sidebar.sectionIcon.loadFailed")}</span>
        <Button type="button" size="xs" variant="outline" onClick={() => props.onRetry()}>
          {t("common.retry")}
        </Button>
      </div>
    </Show>
  );
}

export function SectionGlyphPicker(props: {
  selected: SidebarSectionGlyph | null;
  onSelect: (glyph: SidebarSectionGlyph) => void;
}) {
  const { t, locale } = useText();
  const [query, setQuery] = createSignal("");
  const [category, setCategory] = createSignal<SectionIconCategory | null>(null);
  let search: HTMLInputElement | undefined;
  let grid: PickerGridHandle | undefined;
  // After the first render: a load writes signals, which a render must not do.
  onSettled(() => {
    loadSectionIconLibrary();
    search?.focus();
  });

  const results = createMemo(() => {
    const library = sectionIconLibrary();
    return library ? searchSectionPicker(library.entries, query(), category()) : [];
  });
  const recent = createMemo(() => {
    const library = sectionIconLibrary();
    if (!library || query().trim() !== "" || category() !== null) return [];
    const byGlyph = new Map(library.entries.map((entry) => [entry.glyph, entry]));
    return sectionIconRecents().glyphs.flatMap((glyph) => byGlyph.get(glyph) ?? []);
  });
  const label = (entry: SectionIconEntry) =>
    isSidebarSectionBuiltinGlyph(entry.glyph)
      ? t(SIDEBAR_SECTION_GLYPH_LABELS[entry.glyph])
      : locale() === "pt"
        ? entry.pt
        : entry.en;
  const itemKey = (entry: SectionIconEntry) => entry.glyph;
  const renderItem = (entry: SectionIconEntry) => <SectionGlyphIcon glyph={entry.glyph} class="section-picker-glyph" />;
  const pick = (entry: SectionIconEntry) => props.onSelect(entry.glyph);

  return (
    <div class="section-picker">
      <PickerSearch
        label={t("sidebar.sectionIcon.searchIcons")}
        value={query()}
        onValueChange={setQuery}
        grid={() => grid}
        ref={(element) => {
          search = element;
        }}
      />
      <fieldset class="section-picker-categories" aria-label={t("sidebar.sectionIcon.categories")}>
        <Button
          type="button"
          size="xs"
          variant={category() === null ? "secondary" : "ghost"}
          aria-pressed={category() === null ? "true" : "false"}
          onClick={() => setCategory(null)}
        >
          {t("sidebar.sectionIcon.category.all")}
        </Button>
        <For each={SECTION_ICON_CATEGORIES}>
          {(value) => (
            <Button
              type="button"
              size="xs"
              variant={category() === value ? "secondary" : "ghost"}
              aria-pressed={category() === value ? "true" : "false"}
              onClick={() => setCategory(value)}
            >
              {t(ICON_CATEGORY_LABELS[value])}
            </Button>
          )}
        </For>
      </fieldset>
      <Switch>
        <Match when={!sectionIconLibrary()}>
          <PickerStatus state={sectionIconLibraryState()} onRetry={loadSectionIconLibrary} />
        </Match>
        <Match when={sectionIconLibrary()}>
          <Show when={recent().length > 0}>
            <p class="section-picker-heading">{t("sidebar.sectionIcon.recent")}</p>
            <PickerGrid
              label={t("sidebar.sectionIcon.recent")}
              items={recent()}
              class="section-picker-recent"
              itemKey={itemKey}
              itemLabel={label}
              renderItem={renderItem}
              selectedKey={props.selected}
              onPick={pick}
            />
          </Show>
          <Show
            when={results().length > 0}
            fallback={
              <p class="section-picker-status">{t("sidebar.sectionIcon.noIcons", { query: query().trim() })}</p>
            }
          >
            <PickerGrid
              label={t("sidebar.sectionIcon.iconList")}
              items={results()}
              itemKey={itemKey}
              itemLabel={label}
              renderItem={renderItem}
              selectedKey={props.selected}
              onPick={pick}
              onLeaveTop={() => search?.focus()}
              handle={(handle) => {
                grid = handle;
              }}
            />
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

export function SectionEmojiPicker(props: { selected: string | null; onSelect: (emoji: string) => void }) {
  const { t, locale } = useText();
  const [query, setQuery] = createSignal("");
  const [category, setCategory] = createSignal<SectionEmojiCategory>("faces");
  const [tonesOpen, setTonesOpen] = createSignal(false);
  const tone = () => sectionEmojiTone();
  let search: HTMLInputElement | undefined;
  let grid: PickerGridHandle | undefined;
  onSettled(() => {
    loadSectionEmojiList();
    search?.focus();
  });

  const results = createMemo(() => {
    const list = sectionEmojiList();
    return list ? searchSectionPicker(list.entries, query(), category()) : [];
  });
  /** A recent emoji keeps the tone it was picked with. */
  const recent = createMemo(() => {
    const list = sectionEmojiList();
    if (!list || query().trim() !== "") return [];
    return sectionIconRecents().emoji.flatMap((emoji) => {
      const entry = list.byEmoji.get(emoji);
      return entry ? [{ entry, emoji }] : [];
    });
  });
  const shown = (entry: SectionEmojiEntry) => (entry.skin ? sectionEmojiWithTone(entry.emoji, tone()) : entry.emoji);
  const name = (entry: SectionEmojiEntry) => (locale() === "pt" ? entry.pt : entry.en);

  return (
    <div class="section-picker">
      <PickerSearch
        label={t("sidebar.sectionIcon.searchEmoji")}
        value={query()}
        onValueChange={setQuery}
        grid={() => grid}
        ref={(element) => {
          search = element;
        }}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          class="section-picker-tone-button"
          aria-label={`${t("sidebar.sectionIcon.skinTone")}: ${t(TONE_LABELS[tone()])}`}
          aria-expanded={tonesOpen() ? "true" : "false"}
          onClick={() => setTonesOpen((open) => !open)}
        >
          <span class="section-picker-emoji">{sectionEmojiWithTone("✋", tone())}</span>
        </Button>
      </PickerSearch>
      <Show when={tonesOpen()}>
        <fieldset
          class="section-picker-tones"
          aria-label={t("sidebar.sectionIcon.skinTone")}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            // Escape closes the tones, not the editor.
            event.stopPropagation();
            setTonesOpen(false);
          }}
        >
          <For each={SECTION_EMOJI_TONES}>
            {(value) => (
              <Button
                type="button"
                size="sm"
                variant={tone() === value ? "secondary" : "ghost"}
                aria-label={t(TONE_LABELS[value])}
                aria-pressed={tone() === value ? "true" : "false"}
                onClick={() => {
                  setSectionEmojiTone(value);
                  setTonesOpen(false);
                }}
              >
                <span class="section-picker-emoji">{sectionEmojiWithTone("✋", value)}</span>
              </Button>
            )}
          </For>
        </fieldset>
      </Show>
      <fieldset
        class="section-picker-categories section-picker-emoji-categories"
        aria-label={t("sidebar.sectionIcon.categories")}
      >
        <For each={SECTION_EMOJI_CATEGORIES}>
          {(value) => (
            <Button
              type="button"
              size="sm"
              variant={category() === value && query().trim() === "" ? "secondary" : "ghost"}
              aria-label={t(EMOJI_CATEGORY_LABELS[value])}
              title={t(EMOJI_CATEGORY_LABELS[value])}
              aria-pressed={category() === value && query().trim() === "" ? "true" : "false"}
              onClick={() => {
                setCategory(value);
                setQuery("");
              }}
            >
              <span class="section-picker-emoji">{EMOJI_CATEGORY_MARKS[value]}</span>
            </Button>
          )}
        </For>
      </fieldset>
      <Switch>
        <Match when={!sectionEmojiList()}>
          <PickerStatus state={sectionEmojiListState()} onRetry={loadSectionEmojiList} />
        </Match>
        <Match when={sectionEmojiList()}>
          <Show when={recent().length > 0}>
            <p class="section-picker-heading">{t("sidebar.sectionIcon.recent")}</p>
            <PickerGrid
              label={t("sidebar.sectionIcon.recent")}
              items={recent()}
              class="section-picker-recent"
              itemKey={(item) => item.emoji}
              itemLabel={(item) => name(item.entry)}
              renderItem={(item) => <span class="section-picker-emoji">{item.emoji}</span>}
              selectedKey={props.selected}
              onPick={(item) => props.onSelect(item.emoji)}
            />
          </Show>
          <Show
            when={results().length > 0}
            fallback={
              <p class="section-picker-status">{t("sidebar.sectionIcon.noEmoji", { query: query().trim() })}</p>
            }
          >
            <PickerGrid
              label={t("sidebar.sectionIcon.emojiList")}
              items={results()}
              itemKey={shown}
              itemLabel={name}
              renderItem={(entry) => <span class="section-picker-emoji">{shown(entry)}</span>}
              selectedKey={props.selected}
              onPick={(entry) => props.onSelect(shown(entry))}
              onLeaveTop={() => search?.focus()}
              handle={(handle) => {
                grid = handle;
              }}
            />
          </Show>
        </Match>
      </Switch>
    </div>
  );
}
