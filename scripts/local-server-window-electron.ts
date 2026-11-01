// Electron side of `scripts/local-server-window-e2e.ts`. It reads the local server environment and
// makes the main window controller as `src/main/index.ts` does, then runs one scenario on a real
// window and writes what it saw to `--result-file`:
// - `child`: the startup calls of a local server, a show request, `ensureMainWindow`, and then a page
//   that something else loads into the window, so that `ready-to-show` comes.
// - `app`: the startup load of the desktop app. The window must show; this proves that the check
//   sees a window that shows.
// Both scenarios also write how LaunchServices registers the process (`lsappinfo`), and the child loads
// a page in an agent browser view of its hidden window and runs script in it, as the agent browser of a local server does.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { translateFor } from "@openbot/i18n";
import { app, type BrowserWindow, WebContentsView } from "electron";
import {
  hideLocalServerFromMacOS,
  LOCAL_SERVER_ENVIRONMENT,
  takeLocalServerChildEnvironment,
} from "../src/main/local-server-child";
import { createMainWindowController, createMainWindowHolder, showMainWindow } from "../src/main/main-window";

function argument(name: string): string {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!value) throw new Error(`Missing --${name}=`);
  return value.slice(name.length + 3);
}

// A closed output must not stop the test app with an error dialog.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

const scenario = argument("scenario");
const resultFile = argument("result-file");
const iconPath = argument("icon");
const pageUrl = process.env.ELECTRON_RENDERER_URL ?? "";
// As `src/main/index.ts`: the switch, then the environment, then the user data path.
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir").trim();
const localServerChild = takeLocalServerChildEnvironment(process.env, userDataDirectory);
const environmentRemoved = Object.values(LOCAL_SERVER_ENVIRONMENT).every((name) => process.env[name] === undefined);
app.setPath("userData", userDataDirectory);
// The child as `src/main/index.ts` makes it. The app scenario has no Dock tile and no activation: a
// window that shows must not take the user's focus.
if (localServerChild) hideLocalServerFromMacOS(process.platform, (policy) => app.setActivationPolicy(policy));
else if (process.platform === "darwin") app.setActivationPolicy("accessory");

let quitting = false;
let loadStarts = 0;
const errors: string[] = [];
const windows = createMainWindowController({
  holder: createMainWindowHolder(),
  statePath: join(userDataDirectory, "openbot-main-window-state-v1.json"),
  appIconPath: iconPath,
  developmentProfile: null,
  developmentRemoteRole: null,
  developmentTestClientEnabled: false,
  isQuitting: () => quitting,
  keepRunningInBackground: () => false,
  getServices: () => null,
  getTranslate: () => translateFor("en"),
  onRendererLoadStarted: () => {
    loadStarts += 1;
  },
  onRendererGone: () => undefined,
  onMainWindowCreated: () => undefined,
  reportError: (message) => errors.push(message),
  headless: localServerChild !== null,
});

interface WindowState {
  url: string;
  visible: boolean;
  /** Calls of `onRendererLoadStarted`: one for a load call of the controller, one for each navigation. */
  loadStarts: number;
}

interface ChildSteps {
  afterLoad: WindowState;
  afterShowRequest: { visible: boolean };
  afterEnsure: WindowState & { sameWindow: boolean };
  afterPaint: { visible: boolean };
  /** An agent browser view in the hidden window: the page loads and runs script. */
  agentView: { title: string; windowVisible: boolean };
}

interface AppSteps {
  afterPaint: WindowState;
}

/** The first paint of a page, which is when the controller decides whether the window shows. */
function readyToShow(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => window.once("ready-to-show", () => resolve()));
}

/** A window that shows must stay out of sight: no opacity, and it cannot take focus. */
function outOfSight(window: BrowserWindow): BrowserWindow {
  window.setOpacity(0);
  window.setFocusable(false);
  return window;
}

async function runChild(): Promise<ChildSteps> {
  // The startup of `src/main/index.ts`: open the window, then the call that loads the app's renderer.
  const window = outOfSight(windows.openMainWindow());
  await windows.loadRenderer(window);
  const afterLoad = { url: window.webContents.getURL(), visible: window.isVisible(), loadStarts };
  // What a second launch, a notification or the Dynamic Island does.
  showMainWindow(window);
  const afterShowRequest = { visible: window.isVisible() };
  const ensured = await windows.ensureMainWindow();
  const afterEnsure = {
    sameWindow: ensured === window,
    url: window.webContents.getURL(),
    visible: window.isVisible(),
    loadStarts,
  };
  // A page that something else loads. `ready-to-show` then comes, and the window must stay hidden.
  const painted = readyToShow(window);
  await window.loadURL(pageUrl);
  await painted;
  const afterPaint = { visible: window.isVisible() };
  return { afterLoad, afterShowRequest, afterEnsure, afterPaint, agentView: await loadAgentView(window) };
}

/** What the agent browser of a local server does: a view in the hidden window loads a page. */
async function loadAgentView(window: BrowserWindow): Promise<ChildSteps["agentView"]> {
  const view = new WebContentsView();
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  await view.webContents.loadURL(`${pageUrl}&view=agent`);
  const result = {
    title: String(await view.webContents.executeJavaScript("document.title")),
    windowVisible: window.isVisible(),
  };
  window.contentView.removeChildView(view);
  view.webContents.close();
  return result;
}

/** How LaunchServices registers this process: "Foreground", "UIElement" or "BackgroundOnly". */
function macApplicationType(): string | null {
  if (process.platform !== "darwin") return null;
  const output = execFileSync("/usr/bin/lsappinfo", ["info", "-only", "ApplicationType", "-app", String(process.pid)], {
    encoding: "utf8",
  });
  return /"ApplicationType"="([^"]+)"/u.exec(output)?.[1] ?? null;
}

async function runApp(): Promise<AppSteps> {
  const window = outOfSight(windows.openMainWindow());
  const painted = readyToShow(window);
  await windows.loadRenderer(window);
  await painted;
  return { afterPaint: { url: window.webContents.getURL(), visible: window.isVisible(), loadStarts } };
}

// No top-level await: Electron does not get ready until an ESM main module has run to its end.
void app.whenReady().then(async () => {
  let steps: ChildSteps | AppSteps | null = null;
  let failure: string | undefined;
  let applicationType: string | null = null;
  try {
    steps = scenario === "child" ? await runChild() : await runApp();
    // Read after the window steps: the registration must also hold after a window and a view exist.
    applicationType = macApplicationType();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(
    resultFile,
    JSON.stringify({
      scenario,
      headless: localServerChild !== null,
      environmentRemoved,
      pageUrl,
      steps,
      applicationType,
      errors,
      failure,
    }),
  );
  quitting = true;
  app.quit();
});
