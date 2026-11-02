/**
 * The popup: the link to the app, Stop all and Resume, and each project with its agents, its tabs, a
 * pause, and the floor sites it hit. Allowing one of those sites for one project needs a choice among
 * three sites at random places.
 */

import { ask, button, el, setLanguage } from "../shared/dom";
import type { LinkView, ProjectView, StatusView } from "../shared/messages";
import { type TextKey, t } from "../shared/text";

const LINK_TEXT: Readonly<{ [link in LinkView]: TextKey }> = {
  connected: "chromeExtension.popup.connected",
  "app-offline": "chromeExtension.popup.appOffline",
  "not-paired": "chromeExtension.popup.notPaired",
  "no-host": "chromeExtension.popup.noHost",
  connecting: "chromeExtension.popup.connecting",
};

const root = document.getElementById("root");

async function refresh(): Promise<void> {
  const answer = await ask({ kind: "status" });
  if (answer.kind === "status") render(answer.status);
}

async function act(request: Parameters<typeof ask>[0]): Promise<void> {
  await ask(request);
  await refresh();
}

function render(status: StatusView): void {
  if (!root) return;
  const header = el(
    "header",
    { className: "row" },
    el("span", { className: `dot link-${status.link}` }),
    el("strong", { text: t(LINK_TEXT[status.link]) }),
    status.link !== "connected" && button(t("chromeExtension.popup.connect"), () => void act({ kind: "connect" })),
  );
  const stop = status.stopped
    ? el(
        "section",
        { className: "stopped" },
        el("p", { text: t("chromeExtension.popup.stoppedNote") }),
        button(t("chromeExtension.popup.resume"), () => void act({ kind: "resume.all" }), "button primary"),
      )
    : button(t("chromeExtension.popup.stopAll"), () => void act({ kind: "stop.all" }), "button danger");
  const projects =
    status.projects.length === 0
      ? el("p", { className: "muted", text: t("chromeExtension.popup.noProjects") })
      : el("ul", { className: "projects" }, ...status.projects.map(renderProject));
  root.replaceChildren(
    header,
    stop,
    projects,
    el(
      "footer",
      {},
      button(t("chromeExtension.popup.disconnect"), () => void act({ kind: "disconnect" }), "link"),
    ),
  );
}

function renderProject(project: ProjectView): HTMLLIElement {
  const swatch = el("span", { className: "swatch" });
  swatch.style.backgroundColor = project.paused ? "#5f6368" : project.color;
  const title = el(
    "div",
    { className: "row" },
    swatch,
    el("strong", { text: project.title }),
    el("span", { className: "muted", text: t("chromeExtension.popup.tabCount", [String(project.tabs)]) }),
    project.paused
      ? button(
          t("chromeExtension.popup.resume"),
          () => void act({ kind: "project.resume", projectKey: project.projectKey }),
        )
      : button(
          t("chromeExtension.popup.pause"),
          () => void act({ kind: "project.pause", projectKey: project.projectKey }),
        ),
  );
  const agents = el(
    "div",
    { className: "agents" },
    ...project.agents.map((agent) =>
      el("span", { className: agent.active ? "agent active" : "agent", text: agent.initials, label: agent.label }),
    ),
  );
  const blocked =
    project.blocked.length > 0 &&
    el(
      "section",
      { className: "floor" },
      el("h3", { text: t("chromeExtension.popup.blockedTitle") }),
      el("p", { className: "muted", text: t("chromeExtension.popup.blockedHelp") }),
      ...project.blocked.map((origin) => blockedRow(project.projectKey, origin)),
    );
  const allowed =
    project.unlocked.length > 0 &&
    el(
      "section",
      { className: "floor" },
      el("h3", { text: t("chromeExtension.popup.allowedTitle") }),
      ...project.unlocked.map((origin) =>
        el(
          "div",
          { className: "row" },
          el("span", { text: origin }),
          button(
            t("chromeExtension.popup.blockAgain"),
            () => void act({ kind: "floor.relock", projectKey: project.projectKey, origin }),
          ),
        ),
      ),
    );
  return el("li", {}, title, agents, blocked, allowed);
}

function blockedRow(projectKey: string, origin: string): HTMLDivElement {
  const row = el("div", { className: "row" });
  const offer = async () => {
    const answer = await ask({ kind: "floor.options", projectKey, origin });
    if (answer.kind !== "floor.options") return;
    const choices = answer.options.map((option) => button(option, () => void choose(option), "button choice"));
    row.replaceChildren(
      el("p", { text: t("chromeExtension.popup.allowPrompt", [origin]) }),
      ...choices,
      button(t("chromeExtension.popup.cancel"), () => void refresh(), "link"),
    );
  };
  const choose = async (choice: string) => {
    const answer = await ask({ kind: "floor.unlock", projectKey, origin, choice });
    if (answer.kind === "error") row.replaceChildren(el("p", { text: t("chromeExtension.popup.choiceMismatch") }));
    else await refresh();
  };
  row.append(
    el("span", { text: origin }),
    button(t("chromeExtension.popup.allow"), () => void offer()),
  );
  return row;
}

setLanguage();
void refresh();
