/**
 * A marker in a section: a thin line with a short text. It drags as a chat row does. A click opens its
 * editor: the text, with suggestions, and the style of the chats below it, up to the next marker.
 */

import {
  SIDEBAR_MARKER_LIMITS,
  SIDEBAR_MARKER_STYLES,
  type SidebarMarker,
  type SidebarMarkerStyle,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, Popover, Text } from "@openbot/ui";
import { createStore, For, Show, untrack } from "solid-js";
import { useText } from "../../text";
import { SIDEBAR_SECTION_COLOR_PRESETS } from "./section-color";
import { sidebarMarkerAccent } from "./sidebar-markers-view";
import { useSidebarScope } from "./sidebar-scope";

const STYLE_LABELS = {
  normal: "sidebar.marker.style.normal",
  dim: "sidebar.marker.style.dim",
  grayscale: "sidebar.marker.style.grayscale",
  tint: "sidebar.marker.style.tint",
} as const satisfies Record<SidebarMarkerStyle, AppTextKey>;

const SUGGESTIONS = [
  "sidebar.marker.suggestion.done",
  "sidebar.marker.suggestion.soon",
  "sidebar.marker.suggestion.waiting",
] as const satisfies readonly AppTextKey[];

/** The tint color when the user picks the tint style on a marker with no color. */
const DEFAULT_TINT = SIDEBAR_SECTION_COLOR_PRESETS[6]?.color ?? "#3b82f6";

export function SidebarMarkerRow(rowProps: { marker: SidebarMarker }) {
  const { draggedChatId, dragOffset, endChatDragging, layoutMutable, markers, props, startChatDragging } =
    useSidebarScope();
  const { t } = useText();
  const name = () => rowProps.marker.label || t("sidebar.marker.unnamed");
  const editable = () => markers.supported() && layoutMutable();
  // The line and the text take the color that was picked, so the marker shows it as the rows below do.
  const accent = () => sidebarMarkerAccent(rowProps.marker);
  return (
    <div
      class={[
        "sidebar-marker sidebar-agent-item",
        {
          "sidebar-agent-item-dragging": draggedChatId() === rowProps.marker.id,
          "sidebar-drag-shifting": dragOffset(rowProps.marker.id).y !== 0,
        },
      ]}
      style={`--sidebar-drag-y: ${dragOffset(rowProps.marker.id).y}px;${accent() ? ` --sidebar-marker-color: ${accent()};` : ""}`}
      data-marker-style={rowProps.marker.style}
      data-marker-color={accent() ? "" : undefined}
    >
      {/* The separator that a screen reader reads, with the text as its name. The line on screen is in the button. */}
      <hr class="sr-only" aria-label={t("sidebar.marker.rowLabel", { label: name() })} />
      <Popover.Root
        open={markers.openMarkerId() === rowProps.marker.id}
        onOpenChange={(open) => markers.setOpenMarkerId(open ? rowProps.marker.id : null)}
        placement="bottom-start"
        gutter={4}
      >
        <Popover.Trigger
          as="button"
          type="button"
          class="sidebar-marker-trigger"
          disabled={!editable()}
          aria-label={t("sidebar.marker.edit", { label: name() })}
          // The drag pipeline measures this element and moves the wrapper, as for a chat row.
          data-chat-id={rowProps.marker.id}
          draggable={editable() && !props.compact ? "true" : "false"}
          onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) =>
            startChatDragging(event, rowProps.marker.id)
          }
          onDragEnd={endChatDragging}
        >
          <span class="sidebar-marker-label">{rowProps.marker.label}</span>
          <span class="sidebar-marker-line" aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            class="ui-popover-menu-surface sidebar-marker-editor"
            aria-label={t("sidebar.marker.editor")}
          >
            {/* The content mounts on each open, so each open starts from the saved marker. */}
            <SidebarMarkerEditor marker={rowProps.marker} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** The text, the suggestions, the style and the remove action of one marker. Enter saves, Escape closes. */
function SidebarMarkerEditor(editorProps: { marker: SidebarMarker }) {
  const { markers } = useSidebarScope();
  const { t, errorMessage } = useText();
  const initial = untrack(() => editorProps.marker);
  const [draft, setDraft] = createStore<MarkerDraft>({
    label: initial.label,
    style: initial.style,
    color: initial.color ?? null,
    saving: false,
    error: null,
  });
  const close = () => markers.setOpenMarkerId(null);

  async function run(action: () => Promise<void>): Promise<void> {
    if (draft.saving) return;
    setDraft((state) => {
      state.saving = true;
      state.error = null;
    });
    try {
      await action();
      close();
    } catch (cause) {
      setDraft((state) => {
        state.saving = false;
        state.error = errorMessage(cause, t("sidebar.marker.saveFailed"));
      });
    }
  }

  const save = () =>
    run(() =>
      markers.saveMarker(initial.id, {
        label: draft.label.trim(),
        style: draft.style,
        color: draft.style === "tint" ? (draft.color ?? DEFAULT_TINT) : null,
      }),
    );

  return (
    <form
      class="sidebar-marker-form"
      novalidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        value={draft.label}
        maxlength={SIDEBAR_MARKER_LIMITS.label}
        autocomplete="off"
        autofocus
        placeholder={t("sidebar.marker.placeholder")}
        aria-label={t("sidebar.marker.label")}
        onValueChange={(value) =>
          setDraft((state) => {
            state.label = value;
          })
        }
      />
      <fieldset class="sidebar-marker-suggestions">
        <legend class="sr-only">{t("sidebar.marker.suggestions")}</legend>
        <For each={SUGGESTIONS}>
          {(key) => (
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-pressed={draft.label === t(key) ? "true" : "false"}
              onClick={() =>
                setDraft((state) => {
                  state.label = t(key);
                })
              }
            >
              {t(key)}
            </Button>
          )}
        </For>
      </fieldset>
      <fieldset class="sidebar-marker-styles">
        <legend class="sidebar-marker-legend">{t("sidebar.marker.style")}</legend>
        <For each={SIDEBAR_MARKER_STYLES}>
          {(style) => (
            <Button
              type="button"
              size="xs"
              variant={draft.style === style ? "secondary" : "ghost"}
              aria-pressed={draft.style === style ? "true" : "false"}
              onClick={() =>
                setDraft((state) => {
                  state.style = style;
                  if (style === "tint" && !state.color) state.color = DEFAULT_TINT;
                })
              }
            >
              {t(STYLE_LABELS[style])}
            </Button>
          )}
        </For>
      </fieldset>
      <Show when={draft.style === "tint"}>
        <fieldset class="sidebar-marker-colors">
          <legend class="sr-only">{t("sidebar.marker.style.tint")}</legend>
          <For each={SIDEBAR_SECTION_COLOR_PRESETS}>
            {(preset) => (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                class="sidebar-marker-color"
                aria-label={t(preset.label)}
                aria-pressed={draft.color === preset.color ? "true" : "false"}
                style={`--sidebar-marker-color: ${preset.color};`}
                onClick={() =>
                  setDraft((state) => {
                    state.color = preset.color;
                  })
                }
              >
                <span class="sidebar-marker-swatch" aria-hidden="true" />
              </Button>
            )}
          </For>
        </fieldset>
      </Show>
      <Show when={draft.error}>
        {(message) => (
          <Text role="alert" class="sidebar-marker-error">
            {message()}
          </Text>
        )}
      </Show>
      <div class="sidebar-marker-actions">
        <Button
          type="button"
          size="sm"
          variant="destructive-ghost"
          class="sidebar-marker-remove"
          disabled={draft.saving}
          onClick={() => void run(() => markers.removeMarker(initial.id))}
        >
          {t("sidebar.marker.remove")}
        </Button>
        <Button type="submit" size="sm" disabled={draft.saving}>
          {draft.saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/** The text and the style being chosen, the save in flight, and why the last try failed. */
interface MarkerDraft {
  label: string;
  style: SidebarMarkerStyle;
  color: string | null;
  saving: boolean;
  error: string | null;
}
