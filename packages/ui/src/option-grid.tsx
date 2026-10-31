import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, flush } from "solid-js";

/** What a field above the grid asks of it, such as a search field. */
export interface OptionGridHandle {
  /** Moves the focus to the active option. */
  focusFirst: () => void;
  /** Picks the first option. */
  pickFirst: () => void;
}

export interface OptionGridProps<T> {
  label: string;
  items: readonly T[];
  /** The options in one row. The stylesheet of the caller draws the same number. */
  columns: number;
  /** The options that render first, and that render more at a time. */
  batch: number;
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  renderItem: (item: T) => JSX.Element;
  selectedKey: string | null;
  onPick: (item: T) => void;
  /** Up from the first row: the caller moves the focus, such as back to a search field. */
  onLeaveTop?: (() => void) | undefined;
  handle?: ((handle: OptionGridHandle) => void) | undefined;
  class?: string | undefined;
  itemClass?: string | undefined;
}

const MOVES: Readonly<Record<string, (columns: number) => number>> = {
  ArrowLeft: () => -1,
  ArrowRight: () => 1,
  ArrowUp: (columns) => -columns,
  ArrowDown: (columns) => columns,
  PageUp: (columns) => -columns * 4,
  PageDown: (columns) => columns * 4,
};

/**
 * A grid of options that is a listbox: the arrow keys move in rows of `columns`, Page Up and Page Down
 * move four rows, Home and End go to the ends, and Enter or Space picks. One option at a time is in
 * the tab order. The grid renders the first `batch` options and adds more while it scrolls or while
 * the keys move past them, so a list of hundreds of options stays fast.
 */
export function OptionGrid<T>(props: OptionGridProps<T>): JSX.Element {
  let list: HTMLDivElement | undefined;
  const [count, setCount] = createSignal(props.batch);
  const [active, setActive] = createSignal(0);
  const shown = createMemo(() => props.items.slice(0, count()));

  // A new list starts at its first rows, with the selected item active when the list has it.
  createEffect(
    () => props.items,
    (items) => {
      const selected = items.findIndex((item) => props.itemKey(item) === props.selectedKey);
      setActive(Math.max(0, selected));
      setCount(Math.max(props.batch, Math.ceil((selected + 1) / props.batch) * props.batch));
      if (list) list.scrollTop = 0;
    },
  );

  function focusIndex(index: number): void {
    const target = Math.min(Math.max(index, 0), props.items.length - 1);
    if (target < 0) return;
    if (target >= count()) setCount(Math.ceil((target + 1) / props.batch) * props.batch);
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

  function keyDown(event: KeyboardEvent): void {
    const current = active();
    const move = MOVES[event.key]?.(props.columns);
    if (move !== undefined) {
      event.preventDefault();
      if (event.key === "ArrowUp" && current < props.columns && props.onLeaveTop) props.onLeaveTop();
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
      class={props.class}
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
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 120)
          setCount((value) => value + props.batch);
      }}
    >
      <For each={shown()}>
        {(item, index) => (
          <button
            type="button"
            role="option"
            class={props.itemClass}
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
