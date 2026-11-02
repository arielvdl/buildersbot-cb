/**
 * The welcome page: the disclosure that the store asks for (what is read, where it goes, what is never
 * touched, how to stop), then the pairing. The page shows the words that Chrome computed, and asks the
 * person to tap, among three options, the words that the app shows. That tap is the consent and the
 * check on the Chrome side; nothing is copied or typed.
 */

import { ask, button, el, setLanguage } from "../shared/dom";
import type { StatusView } from "../shared/messages";
import { type TextKey, t } from "../shared/text";

const root = document.getElementById("pairing");
const DEEP_LINK = "buildersbot://browser/connect";
let result: TextKey | null = null;
let busy = false;

function section(title: TextKey, body: TextKey): HTMLElement {
  return el("section", {}, el("h2", { text: t(title) }), el("p", { text: t(body) }));
}

function renderDisclosure(): void {
  const host = document.getElementById("disclosure");
  if (!host) return;
  host.replaceChildren(
    el("h1", { text: t("chromeExtension.welcome.title") }),
    el("p", { className: "lead", text: t("chromeExtension.welcome.intro") }),
    section("chromeExtension.welcome.readsTitle", "chromeExtension.welcome.reads"),
    section("chromeExtension.welcome.whereTitle", "chromeExtension.welcome.where"),
    section("chromeExtension.welcome.neverTitle", "chromeExtension.welcome.never"),
    section("chromeExtension.welcome.stopTitle", "chromeExtension.welcome.stop"),
    el("p", { className: "muted", text: t("chromeExtension.welcome.pin") }),
  );
}

async function choose(index: number | null): Promise<void> {
  if (busy) return;
  busy = true;
  const answer = await ask(index === null ? { kind: "pair.decline" } : { kind: "pair.choose", index });
  busy = false;
  if (answer.kind === "pairing") {
    result =
      answer.result === "paired"
        ? "chromeExtension.welcome.paired"
        : answer.result === "mismatch"
          ? "chromeExtension.welcome.mismatch"
          : "chromeExtension.welcome.declined";
  }
  await refresh();
}

let shown = "";

function render(status: StatusView): void {
  if (!root) return;
  // Draw again only when something changed, so a button never moves under the person's pointer.
  const key = JSON.stringify([status.link, status.pairing, status.platform, result]);
  if (key === shown) return;
  shown = key;
  const title = el("h2", { text: t("chromeExtension.welcome.pairTitle") });
  if (status.platform !== "" && status.platform !== "mac") {
    root.replaceChildren(title, el("p", { text: t("chromeExtension.welcome.unsupported") }));
    return;
  }
  if (status.pairing) {
    const options = status.pairing.options.map((words, index) =>
      button(words.join(" · "), () => void choose(index), "button choice"),
    );
    root.replaceChildren(
      title,
      el("p", { text: t("chromeExtension.welcome.showWords") }),
      el("p", { className: "words", text: status.pairing.chrome.join(" · ") }),
      el("p", { text: t("chromeExtension.welcome.chooseWords") }),
      el("div", { className: "choices" }, ...options),
      button(t("chromeExtension.welcome.notNow"), () => void choose(null), "link"),
    );
    return;
  }
  if (status.link === "connected") {
    root.replaceChildren(title, el("p", { className: "ok", text: t("chromeExtension.welcome.paired") }));
    return;
  }
  const retry = button(t("chromeExtension.welcome.tryAgain"), () => {
    result = null;
    void ask({ kind: "connect" }).then(refresh);
  });
  if (result !== null) {
    root.replaceChildren(title, el("p", { text: t(result) }), retry);
    return;
  }
  if (status.link === "no-host") {
    const open = button(
      t("chromeExtension.welcome.openApp"),
      () => {
        // The app treats this link as untrusted: it only brings up its own "Connect Chrome" card.
        window.location.href = DEEP_LINK;
      },
      "button primary",
    );
    root.replaceChildren(
      title,
      el("p", { text: t("chromeExtension.welcome.noHost") }),
      open,
      el("p", { className: "muted", text: t("chromeExtension.welcome.restart") }),
    );
    return;
  }
  root.replaceChildren(title, el("p", { className: "muted", text: t("chromeExtension.welcome.waiting") }));
}

async function refresh(): Promise<void> {
  const answer = await ask({ kind: "status" });
  if (answer.kind === "status") render(answer.status);
}

setLanguage();
renderDisclosure();
void refresh();
// While this page is open and Chrome is not connected, look again every 2 s (DESIGN §3.2): the page is
// short-lived, and the worker itself never polls.
setInterval(() => {
  void ask({ kind: "status" }).then((answer) => {
    if (answer.kind !== "status") return;
    if (answer.status.link === "no-host" && result === null) void ask({ kind: "connect" });
    render(answer.status);
  });
}, 2_000);
