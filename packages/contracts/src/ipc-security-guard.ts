// The security reviewer that reads every message a person sends, before the agent acts.
//
// The reviewer is on by default: a message that arrives from a page, a README, a transcript or an
// image can carry instructions that were not written for this agent. The reviewer reports them,
// and the prompt of the turn says what it found. It never edits or removes the message.

/** How many messages the reviewer reads: every one, or only those a local scan marks. */
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

export const SECURITY_GUARD_SCOPES = ["all", "signals"] as const;
export type SecurityGuardScope = (typeof SECURITY_GUARD_SCOPES)[number];

/**
 * Annotate adds the verdict to the prompt. Strict also tells the agent that embedded instructions
 * must not be followed unless the verdict says they are safe.
 */
export const SECURITY_GUARD_MODES = ["annotate", "strict"] as const;
export type SecurityGuardMode = (typeof SECURITY_GUARD_MODES)[number];

/** The verdicts of the reviewer, from the safest to the most severe. */
export const SECURITY_GUARD_LEVELS = ["clean", "suspicious", "injection"] as const;
export type SecurityGuardLevel = (typeof SECURITY_GUARD_LEVELS)[number];

/** The bounds of the review deadline, in milliseconds. */
export const SECURITY_GUARD_TIMEOUT_MS = { min: 3_000, max: 120_000 } as const;

/** The most characters of one message that the reviewer reads. */
export const SECURITY_GUARD_CONTENT_LIMIT = 24_000;

export interface SecurityGuardPreference {
  /** On by default. */
  enabled: boolean;
  scope: SecurityGuardScope;
  mode: SecurityGuardMode;
  /** The verdict from which the prompt changes. A lower verdict only adds a clean line. */
  minLevel: SecurityGuardLevel;
  /** A model id for the reviewer. Null reviews with the model of the agent that receives the message. */
  model: string | null;
  /** How long the reviewer may take before the turn starts without it. */
  timeoutMs: number;
}

/** The choices to change. A choice that is not given keeps its value. */
export interface SecurityGuardPreferenceChange {
  enabled?: boolean;
  scope?: SecurityGuardScope;
  mode?: SecurityGuardMode;
  minLevel?: SecurityGuardLevel;
  model?: string | null;
  timeoutMs?: number;
}

/** On, every message, annotate, from suspicious. */
export const DEFAULT_SECURITY_GUARD_PREFERENCE: SecurityGuardPreference = {
  enabled: true,
  scope: "all",
  mode: "annotate",
  minLevel: "suspicious",
  model: null,
  timeoutMs: 20_000,
};

function oneOf<Value extends string>(values: readonly Value[], value: unknown): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

export function isSecurityGuardPreference(value: unknown): value is SecurityGuardPreference {
  return (
    isDynamicRecord(value) &&
    typeof value.enabled === "boolean" &&
    oneOf(SECURITY_GUARD_SCOPES, value.scope) &&
    oneOf(SECURITY_GUARD_MODES, value.mode) &&
    oneOf(SECURITY_GUARD_LEVELS, value.minLevel) &&
    (value.model === null || typeof value.model === "string") &&
    typeof value.timeoutMs === "number" &&
    Number.isInteger(value.timeoutMs) &&
    value.timeoutMs >= SECURITY_GUARD_TIMEOUT_MS.min &&
    value.timeoutMs <= SECURITY_GUARD_TIMEOUT_MS.max
  );
}

/** Reads the change a window sends. At least one choice is required. */
export function parseSecurityGuardPreferenceChange(input: unknown): SecurityGuardPreferenceChange {
  if (!isDynamicRecord(input)) throw new Error("The security guard change is required.");
  const change: SecurityGuardPreferenceChange = {};
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") throw new Error("The security guard switch is invalid.");
    change.enabled = input.enabled;
  }
  if ("scope" in input) {
    if (!oneOf(SECURITY_GUARD_SCOPES, input.scope)) throw new Error("The security guard scope is invalid.");
    change.scope = input.scope;
  }
  if ("mode" in input) {
    if (!oneOf(SECURITY_GUARD_MODES, input.mode)) throw new Error("The security guard mode is invalid.");
    change.mode = input.mode;
  }
  if ("minLevel" in input) {
    if (!oneOf(SECURITY_GUARD_LEVELS, input.minLevel)) throw new Error("The security guard level is invalid.");
    change.minLevel = input.minLevel;
  }
  if ("model" in input) {
    if (input.model !== null && typeof input.model !== "string")
      throw new Error("The security guard model is invalid.");
    change.model = input.model;
  }
  if ("timeoutMs" in input) {
    const timeout = input.timeoutMs;
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < SECURITY_GUARD_TIMEOUT_MS.min ||
      timeout > SECURITY_GUARD_TIMEOUT_MS.max
    )
      throw new Error("The security guard deadline is invalid.");
    change.timeoutMs = timeout;
  }
  if (Object.keys(change).length === 0) throw new Error("The security guard change is required.");
  return change;
}
