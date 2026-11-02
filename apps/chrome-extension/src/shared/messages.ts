/**
 * Messages between the extension's own pages (popup, welcome) and its service worker. Nothing outside
 * the extension can send them: there is no `externally_connectable` entry and no external listener, and
 * the worker also checks that the sender is a page of this extension.
 */

export type PageRequest =
  | { kind: "status" }
  | { kind: "connect" }
  | { kind: "pair.choose"; index: number }
  | { kind: "pair.decline" }
  | { kind: "disconnect" }
  | { kind: "stop.all" }
  | { kind: "resume.all" }
  | { kind: "project.pause"; projectKey: string }
  | { kind: "project.resume"; projectKey: string }
  | { kind: "floor.options"; projectKey: string; origin: string }
  | { kind: "floor.unlock"; projectKey: string; origin: string; choice: string }
  | { kind: "floor.relock"; projectKey: string; origin: string };

export type LinkView = "connected" | "app-offline" | "not-paired" | "no-host" | "connecting";

export interface ProjectView {
  projectKey: string;
  title: string;
  color: string;
  paused: boolean;
  pausedByPerson: boolean;
  tabs: number;
  agents: { label: string; initials: string; active: boolean }[];
  blocked: string[];
  unlocked: string[];
}

export interface StatusView {
  link: LinkView;
  stopped: boolean;
  projects: ProjectView[];
  pairing: { chrome: readonly string[]; options: readonly (readonly string[])[] } | null;
  heldForGesture: boolean;
  platform: string;
}

export type PageResponse =
  | { kind: "status"; status: StatusView }
  | { kind: "pairing"; result: "paired" | "mismatch" | "declined" | "none" }
  | { kind: "floor.options"; options: string[] }
  | { kind: "ok" }
  | { kind: "error"; message: string };
