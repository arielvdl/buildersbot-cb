/**
 * A small DOM builder for the extension pages. Text goes in through `textContent` only: a project title
 * or a site comes from the app or a page, and is never parsed as HTML.
 */

import type { PageRequest, PageResponse } from "./messages";

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; label?: string; onClick?: () => void } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.label !== undefined) node.setAttribute("aria-label", options.label);
  if (options.onClick) {
    const click = options.onClick;
    node.addEventListener("click", click);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function button(text: string, onClick: () => void, className = "button"): HTMLButtonElement {
  const node = el("button", { className, text, onClick });
  node.type = "button";
  return node;
}

/** Sends a request to the service worker and returns its answer. */
export async function ask(request: PageRequest): Promise<PageResponse> {
  const answer = await chrome.runtime.sendMessage<PageResponse>(request);
  return answer ?? { kind: "error", message: "no answer" };
}

export function setLanguage(): void {
  document.documentElement.lang = chrome.i18n.getMessage("@@ui_locale").replace("_", "-") || "en";
}
