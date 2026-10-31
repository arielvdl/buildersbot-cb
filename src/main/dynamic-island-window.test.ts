// @vitest-environment node
// The Dynamic Island windows open after the main window has its content: `initialize` reads only the
// saved preference, and `reconcileWindow` opens the windows. Failure modes: `initialize` opens the
// windows again, so the reload of the main window waits for each display's load; `reconcileWindow`
// opens no window, a second window on a display, or a window off macOS.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { BrowserWindow, Display } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicIslandWindowController } from "./dynamic-island-window";

/** A stand-in with only the members that the controller calls. */
function stub<T>(members: Partial<T>): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a test double has only the members that the controller calls.
  return members as T;
}

function fakeWindow(id: number): BrowserWindow {
  let destroyed = false;
  return stub<BrowserWindow>({
    excludedFromShownWindowsMenu: false,
    // A window that is still loading: the controller sends it nothing and waits for `did-finish-load`.
    webContents: stub<BrowserWindow["webContents"]>({
      id,
      on: vi.fn(),
      isDestroyed: () => destroyed,
      isLoadingMainFrame: () => true,
    }),
    setHasShadow: vi.fn(),
    setWindowButtonVisibility: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setHiddenInMissionControl: vi.fn(),
    setFocusable: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setBounds: vi.fn(),
    showInactive: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
  });
}

function display(id: number, internal: boolean): Display {
  return stub<Display>({ id, internal, bounds: { x: id * 2000, y: 0, width: 1512, height: 982 } });
}

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function controller(options: { platform: NodeJS.Platform; preference?: unknown }) {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-island-"));
  directories.push(directory);
  const preferencePath = join(directory, "dynamic-island.json");
  if (options.preference !== undefined) await writeFile(preferencePath, JSON.stringify(options.preference));
  let nextId = 1;
  const createWindow = vi.fn(() => fakeWindow(nextId++));
  const loadWindow = vi.fn(async () => undefined);
  const island = new DynamicIslandWindowController({
    platform: options.platform,
    preferencePath,
    createWindow,
    loadWindow,
    getDisplays: () => [display(1, true), display(2, false)],
    getMainWindow: () => null,
    presentMainWindow: () => undefined,
    performHaptic: () => undefined,
    performCriticalAction: () => Effect.void,
  });
  return { island, createWindow, loadWindow };
}

describe("DynamicIslandWindowController", () => {
  it("reads the preference on initialize and opens no window", async () => {
    const { island, createWindow } = await controller({ platform: "darwin" });

    await Effect.runPromise(island.initialize());

    expect(island.preference.enabled).toBe(true);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("opens one window for each display on reconcile, and no second one", async () => {
    const { island, createWindow, loadWindow } = await controller({ platform: "darwin" });
    await Effect.runPromise(island.initialize());

    await Effect.runPromise(island.reconcileWindow());
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(loadWindow).toHaveBeenCalledTimes(2);

    await Effect.runPromise(island.reconcileWindow());
    expect(createWindow).toHaveBeenCalledTimes(2);
    island.destroy();
  });

  it("opens no window off macOS or when the preference is off", async () => {
    const linux = await controller({ platform: "linux" });
    await Effect.runPromise(linux.island.initialize());
    await Effect.runPromise(linux.island.reconcileWindow());
    expect(linux.createWindow).not.toHaveBeenCalled();

    const off = await controller({ platform: "darwin", preference: { version: 1, enabled: false } });
    await Effect.runPromise(off.island.initialize());
    expect(off.island.preference.enabled).toBe(false);
    await Effect.runPromise(off.island.reconcileWindow());
    expect(off.createWindow).not.toHaveBeenCalled();
  });
});
