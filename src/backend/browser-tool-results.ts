/**
 * The text that a browser tool returns to the model. The Builders Bot browser (`BrowserHost`) and the
 * person's Chrome (`ChromeTabsHost`) answer each tool in the same format, so an agent reads one shape
 * whichever browser it drives.
 */

import type { BrowserElement, BrowserImageMode, BrowserSnapshot } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { BrowserCardFillResult } from "./browser-card-fill";
import type { SnapshotReadResult } from "./browser-cdp";
import type { BrowserScriptResult } from "./browser-script";
import type { BrowserFillFieldsResult, DialogTabResult } from "./browser-tab-operations";
import type { DynamicToolResult } from "./protocol";

export function textResult(value: unknown): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

/** An action that closed its tab returns this in place of a snapshot. */
export type ClosedTabResult = { tabId: string; closed: true; openerTabId?: string };

/** A tool result that is a snapshot, or a fill result that carries one. */
export type SnapshotToolPayload =
  | BrowserSnapshot
  | ClosedTabResult
  | DialogTabResult
  | BrowserFillFieldsResult
  | (Pick<BrowserCardFillResult, "filled"> &
      Partial<Pick<BrowserCardFillResult, "unconfirmed">> & {
        snapshot: BrowserSnapshot | ClosedTabResult | DialogTabResult | null;
      })
  | (BrowserScriptResult & { tabId: string; snapshotError?: string; url?: string; snapshot?: BrowserSnapshot });

export function snapshotTextResult(value: SnapshotToolPayload): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: snapshotJson(value) }],
  };
}

/** A snapshot, and its image when the host took one: the image goes as a separate content item. */
export function snapshotImageResult(
  result: SnapshotReadResult,
  mode: BrowserImageMode,
  imageUrl: string | null,
): DynamicToolResult {
  if (!imageUrl) return snapshotTextResult(result.snapshot);
  result.snapshot.image = {
    included: true,
    reason: mode === "always" ? "requested" : result.imageReason,
    width: result.snapshot.viewport.width,
    height: result.snapshot.viewport.height,
  };
  return {
    success: true,
    contentItems: [
      { type: "inputText", text: snapshotJson(result.snapshot) },
      { type: "inputImage", imageUrl },
    ],
  };
}

/**
 * The model reads many snapshots in a task, so the model text is compact. Each element is one line,
 * which leaves out the JSON keys and the empty defaults. The history leaves out what the model already
 * knows: network requests that succeeded, and its own actions that succeeded with no detail. The
 * snapshot tool description says so.
 */
export function snapshotJson(value: SnapshotToolPayload): string {
  return JSON.stringify(value, function (this: unknown, key, field: unknown) {
    if (!Array.isArray(field) || !isDynamicRecord(this) || !Array.isArray(this.elements)) return field;
    return key === "elements" ? field.map(elementLine) : field;
  });
}

/** Tags that the role already implies. The line names a tag only when it adds to the role. */
const ROLE_TAGS: Readonly<Record<string, readonly string[]>> = {
  button: ["button"],
  link: ["a"],
  textbox: ["input", "textarea"],
  searchbox: ["input"],
  // A native select keeps its tag: only it takes select_option.
  combobox: ["input"],
  checkbox: ["input"],
  radio: ["input"],
  slider: ["input"],
  spinbutton: ["input"],
  option: ["option"],
  img: ["img"],
};

/**
 * `ref [role] "name" [<tag>] [value="…"] [description="…"] [state:value…] [bounds=x,y,w,h]
 * [frame=id frameUrl="…"]`. Text values are JSON strings; the other tokens have no spaces.
 */
function elementLine(element: BrowserElement): string {
  const tokens = [element.ref];
  if (element.role) tokens.push(element.role);
  tokens.push(JSON.stringify(element.name));
  if (!element.role || !ROLE_TAGS[element.role]?.includes(element.tag)) tokens.push(`<${element.tag}>`);
  if (element.value !== null) tokens.push(`value=${JSON.stringify(element.value)}`);
  if (element.description) tokens.push(`description=${JSON.stringify(element.description)}`);
  tokens.push(...element.states);
  const { bounds, frame } = element;
  if (bounds) tokens.push(`bounds=${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
  if (frame) tokens.push(`frame=${frame.id}`, `frameUrl=${JSON.stringify(frame.url)}`);
  return tokens.join(" ");
}
