// The welcome page of the stub extension: it shows the words that Chrome shows, and three options for
// the words that the app shows. A tap on an option is the person's choice (and consent).
const status = document.getElementById("status");
const code = document.getElementById("chrome-code");
const options = document.getElementById("options");
let shown = "";

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "state" });
  const view = state?.view;
  status.textContent = view ? `${view.phase}${view.rejected ? ` (${view.rejected})` : ""}` : "starting";
  const key = view?.phase === "pairing" ? JSON.stringify(view.options) : "";
  if (key !== shown) {
    shown = key;
    code.textContent = view?.chromeCode ? view.chromeCode.join(" · ") : "";
    options.replaceChildren(
      ...(view?.phase === "pairing" ? view.options : []).map((words, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = words.join(" · ");
        button.addEventListener("click", () => chrome.runtime.sendMessage({ type: "choose", index }));
        return button;
      }),
    );
  }
}

setInterval(() => void refresh(), 100);
void refresh();
