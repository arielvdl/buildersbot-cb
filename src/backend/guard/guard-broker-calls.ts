// The Guard on the calls that an agent makes to the shared Playwright browser. That browser holds the
// person's own signed-in sites, so a script, a typed text, an address or an upload that it sends
// leaves the computer as the person. The broker checks each `tools/call` before the browser runs it.
// The broker cannot tell which agent and turn a call serves, so it cannot show the approval card: a
// call that would ask the person does not run, and the agent reads why.

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { type GuardPaths, resolveGuardPaths } from "./guard-paths";
import type { GuardAction } from "./guard-policy";
import type { GuardOutboundItem } from "./guard-triage";

/** The tool names of the shared browser in the Guard's records, such as `playwright.browser_type`. */
const PLAYWRIGHT = "playwright";

function stringField(record: unknown, key: string): string | null {
  if (!isDynamicRecord(record)) return null;
  const value = record[key];
  return isString(value) ? value : null;
}

function stringList(record: unknown, key: string): string[] {
  if (!isDynamicRecord(record) || !Array.isArray(record[key])) return [];
  return record[key].filter(isString);
}

/**
 * The part of a shared browser call that leaves the computer, or null when the call sends nothing
 * that an agent chose: a click, a key, a snapshot. Every tool of `@playwright/mcp` that sends a URL,
 * a script, a text, a value or a file has a case here. Code that `browser_run_code_unsafe` loads
 * from a file is not read: `guardBrokerCall` refuses that call.
 */
export function playwrightOutboundItem(name: string, args: unknown): GuardOutboundItem | null {
  const tool = `${PLAYWRIGHT}.${name}`;
  const payload = (text: string | null): GuardOutboundItem | null => (text ? { tool, payload: text } : null);
  switch (name) {
    case "browser_navigate":
    case "browser_tabs": {
      const url = stringField(args, "url");
      return url ? { tool, urls: [url] } : null;
    }
    case "browser_evaluate":
      return payload(stringField(args, "function"));
    case "browser_run_code_unsafe":
      return payload(stringField(args, "code"));
    case "browser_type":
      return payload(stringField(args, "text"));
    case "browser_fill_form": {
      const fields = isDynamicRecord(args) && Array.isArray(args.fields) ? args.fields : [];
      return payload(fields.flatMap((field) => stringField(field, "value") ?? []).join("\n"));
    }
    case "browser_handle_dialog":
      return payload(stringField(args, "promptText"));
    // A cookie goes to its site with the next request, and page scripts of the site read storage.
    case "browser_cookie_set":
    case "browser_localstorage_set":
    case "browser_sessionstorage_set":
      return payload(stringField(args, "value"));
    case "browser_file_upload": {
      const paths = stringList(args, "paths");
      return paths.length > 0 ? { tool, files: paths } : null;
    }
    case "browser_drop": {
      const paths = stringList(args, "paths");
      const data = isDynamicRecord(args) && isDynamicRecord(args.data) ? Object.values(args.data).filter(isString) : [];
      if (paths.length === 0 && data.length === 0) return null;
      return {
        tool,
        ...(paths.length > 0 ? { files: paths } : {}),
        ...(data.length > 0 ? { payload: data.join("\n") } : {}),
      };
    }
    default:
      return null;
  }
}

/** What the Guard decides about one call: its action, and the local reason that the agent may read. */
export interface BrokerCallVerdict {
  readonly action: GuardAction;
  readonly reason: string | null;
}

/** Checks one outbound item with the Guard. It must not fail: the broker treats a failure as a pass. */
export type BrokerCallCheck = (item: GuardOutboundItem) => Promise<BrokerCallVerdict>;

/**
 * What the broker does with one call: run it, with the real paths of its files in place of the paths
 * that the agent gave when they differ, or answer the agent with `text` and not run it.
 */
export type BrokerCallDecision =
  | { readonly proceed: true; readonly paths?: readonly string[] }
  | { readonly proceed: false; readonly text: string };

/**
 * What the agent reads when it asks the shared browser to run code from a file. The Guard reads code,
 * not files, so the agent is told to give the code itself. The agent reads it, so it is English.
 */
export const BROKER_CODE_FILE_REFUSAL =
  "Builders Bot Guard cannot read code from a file in the shared browser, so the call did not run. Give the code in the `code` argument instead.";

/** What the agent reads when the Guard held back a call. The agent reads it, so it is English. */
export function brokerRefusal(reason: string | null): string {
  return `Builders Bot Guard held back this browser call.${reason ? ` ${reason}` : ""} The shared browser cannot ask the person, so the call did not run. Tell the person what you wanted to do and why; do not try it another way.`;
}

/** The real paths behind the files of a call, with no agent workspace: the shared browser opens absolute paths. */
function resolveForBrowser(paths: readonly string[]): Promise<GuardPaths> {
  return Effect.runPromise(resolveGuardPaths(paths, { agentId: PLAYWRIGHT, workspaceRoot: null, sharedRoot: null }));
}

/**
 * Checks one `tools/call` of the shared browser. A file is checked at each path that leads to it, and
 * the call then opens the real paths that the Guard checked, so a link that changes after the check
 * opens nothing new.
 */
export async function guardBrokerCall(
  name: string,
  args: unknown,
  check: BrokerCallCheck,
  resolve: (paths: readonly string[]) => Promise<GuardPaths> = resolveForBrowser,
): Promise<BrokerCallDecision> {
  // Code from a file runs in the Playwright process, with the person's browser; the Guard cannot read it.
  if (name === "browser_run_code_unsafe" && !stringField(args, "code") && stringField(args, "filename"))
    return { proceed: false, text: BROKER_CODE_FILE_REFUSAL };
  const given = playwrightOutboundItem(name, args);
  if (!given) return { proceed: true };
  let item = given;
  let reals: ReadonlyArray<string | null> = [];
  if (given.files && given.files.length > 0) {
    const resolved = await resolve(given.files);
    reals = resolved.reals;
    item = { ...given, files: resolved.paths, ...(resolved.complete ? {} : { unresolved: true }) };
  }
  const verdict = await check(item);
  if (verdict.action === "ask" || verdict.action === "block")
    return { proceed: false, text: brokerRefusal(verdict.reason) };
  const files = given.files ?? [];
  if (files.length === 0) return { proceed: true };
  const paths = files.map((path, index) => reals[index] ?? path);
  if (paths.every((path, index) => path === files[index])) return { proceed: true };
  return { proceed: true, paths };
}
