/**
 * The editor of a section icon: letters, a glyph, or an image from this computer, with a preview of
 * the rail item. It opens from the menu of the section header or of the rail item, and saves one
 * `set-section-icon` action. "Use the first letter" removes the icon.
 */

import {
  isSidebarSectionLetter,
  SIDEBAR_SECTION_GLYPHS,
  type SidebarSection,
  type SidebarSectionGlyph,
  type SidebarSectionIcon,
} from "@openbot/contracts/ipc";
import {
  Button,
  ContextMenu,
  Dialog,
  Field,
  IconButton,
  Image,
  Input,
  Shapes,
  SlidingTabs,
  Text,
  X,
} from "@openbot/ui";
import { Dynamic } from "@solidjs/web";
import { createStore, For, Match, Show, Switch, untrack } from "solid-js";
import { useText } from "../../text";
import { SIDEBAR_SECTION_GLYPH_ICONS, SIDEBAR_SECTION_GLYPH_LABELS, SidebarSectionMark } from "./SidebarSectionMark";
import { sidebarSectionColorStyle } from "./section-color";
import { SIDEBAR_SECTION_ICON_SOURCE_TYPES, sidebarSectionIconFromFile } from "./section-icon-image";
import { useSidebarScope } from "./sidebar-scope";
import { sidebarSectionLetter } from "./sidebar-section-rail";

type IconMode = SidebarSectionIcon["kind"];

const MODES = ["letter", "glyph", "image"] as const satisfies readonly IconMode[];

/** The choice being made, the image being read, and the save in flight. */
interface IconDraft {
  mode: IconMode;
  letters: string;
  glyph: SidebarSectionGlyph | null;
  image: string | null;
  reading: boolean;
  saving: boolean;
  error: string | null;
}

function isIconMode(value: string): value is IconMode {
  return MODES.some((mode) => mode === value);
}

/** The item of a section menu that opens the icon editor. It shows only where the icon can change. */
export function SidebarSectionIconMenuItem(itemProps: { sectionId: string }) {
  const { sectionRail } = useSidebarScope();
  const { t } = useText();
  return (
    <Show when={sectionRail.iconEditable(itemProps.sectionId)}>
      <ContextMenu.Item onSelectAfterClose={() => sectionRail.openIconEditor(itemProps.sectionId)}>
        <Shapes class="agent-context-icon size-4" aria-hidden="true" />
        <span>{t("sidebar.sectionIcon.open")}</span>
      </ContextMenu.Item>
    </Show>
  );
}

export function SidebarSectionIconDialog() {
  const { sectionRail } = useSidebarScope();
  return (
    <Dialog.Root
      open={sectionRail.iconEditorSectionId() !== null}
      onOpenChange={(open) => {
        if (!open) sectionRail.closeIconEditor();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="ui-confirm-dialog-overlay">
          <Dialog.Content as="section" class="ui-dialog-content section-icon-dialog">
            {/* Keyed by id: a save sends a new layout, and the draft must stay while it does. */}
            <Show when={sectionRail.iconEditorSectionId()} keyed>
              {(sectionId) => <SectionIconForm sectionId={sectionId} onClose={sectionRail.closeIconEditor} />}
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SectionIconForm(formProps: { sectionId: string; onClose: () => void }) {
  const { props } = useSidebarScope();
  const { t, errorMessage } = useText();
  const section = (): SidebarSection | undefined =>
    props.layout.sections.find((candidate) => candidate.id === formProps.sectionId);
  // The draft starts from the saved icon once. A save sends a new layout, which must not reset it.
  const initial = untrack(() => section()?.icon);
  const [draft, setDraft] = createStore<IconDraft>({
    mode: initial?.kind ?? "letter",
    letters: initial?.kind === "letter" ? initial.text : "",
    glyph: initial?.kind === "glyph" ? initial.glyph : null,
    image: initial?.kind === "image" ? initial.dataUrl : null,
    reading: false,
    saving: false,
    error: null,
  });
  let fileInput: HTMLInputElement | undefined;
  const defaultLetter = () => sidebarSectionLetter(section()?.name ?? "");
  const lettersValid = () => draft.letters.trim() === "" || isSidebarSectionLetter(draft.letters.trim());

  /** The icon that Save stores: null keeps the first letter. Undefined while the choice is not complete. */
  const choice = (): SidebarSectionIcon | null | undefined => {
    if (draft.mode === "letter") {
      const letters = draft.letters.trim();
      if (letters === "") return null;
      return isSidebarSectionLetter(letters) ? { kind: "letter", text: letters } : undefined;
    }
    if (draft.mode === "glyph") return draft.glyph ? { kind: "glyph", glyph: draft.glyph } : undefined;
    return draft.image ? { kind: "image", dataUrl: draft.image } : undefined;
  };
  const preview = (): SidebarSectionIcon => choice() ?? { kind: "letter", text: defaultLetter() };
  const busy = () => draft.reading || draft.saving;

  async function pickImage(file: File | undefined): Promise<void> {
    if (!file) return;
    setDraft((state) => {
      state.reading = true;
      state.error = null;
    });
    try {
      const dataUrl = await sidebarSectionIconFromFile(file);
      setDraft((state) => {
        state.image = dataUrl;
      });
    } catch (cause) {
      setDraft((state) => {
        state.error = errorMessage(cause, t("app.avatar.processFailed"));
      });
    } finally {
      setDraft((state) => {
        state.reading = false;
      });
      if (fileInput) fileInput.value = "";
    }
  }

  async function save(icon: SidebarSectionIcon | null): Promise<void> {
    if (busy()) return;
    setDraft((state) => {
      state.saving = true;
      state.error = null;
    });
    try {
      await props.onMutateLayout({ type: "set-section-icon", sectionId: formProps.sectionId, icon });
      formProps.onClose();
    } catch (cause) {
      setDraft((state) => {
        state.saving = false;
        state.error = errorMessage(cause, t("sidebar.sectionIcon.saveFailed"));
      });
    }
  }

  return (
    <form
      class="section-icon-form"
      novalidate
      onSubmit={(event) => {
        event.preventDefault();
        const icon = choice();
        if (icon !== undefined) void save(icon);
      }}
    >
      <header class="section-icon-header">
        <Dialog.Title as="h2" class="section-icon-title">
          {t("sidebar.sectionIcon.title")}
        </Dialog.Title>
        <IconButton label={t("common.close")} variant="ghost" onClick={formProps.onClose}>
          <X />
        </IconButton>
      </header>

      <div class="section-icon-preview" aria-live="polite">
        <span
          class="section-icon-preview-tile"
          style={sidebarSectionColorStyle(section()?.color) || undefined}
          data-section-color={sidebarSectionColorStyle(section()?.color) ? "" : undefined}
        >
          <SidebarSectionMark icon={preview()} />
        </span>
        <span class="section-icon-preview-name">{section()?.name ?? ""}</span>
      </div>

      <SlidingTabs.Root
        value={draft.mode}
        onChange={(value: string) => {
          if (isIconMode(value))
            setDraft((state) => {
              state.mode = value;
              state.error = null;
            });
        }}
      >
        <SlidingTabs.List class="section-icon-tabs" aria-label={t("sidebar.sectionIcon.kind")}>
          <SlidingTabs.Trigger value="letter">{t("sidebar.sectionIcon.letter")}</SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="glyph">{t("sidebar.sectionIcon.glyph")}</SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="image">{t("sidebar.sectionIcon.image")}</SlidingTabs.Trigger>
        </SlidingTabs.List>
      </SlidingTabs.Root>

      <Switch>
        <Match when={draft.mode === "letter"}>
          <Field
            label={t("sidebar.sectionIcon.lettersLabel")}
            description={t("sidebar.sectionIcon.lettersHint")}
            error={lettersValid() ? undefined : t("sidebar.sectionIcon.lettersInvalid")}
          >
            <Input
              value={draft.letters}
              placeholder={defaultLetter()}
              maxlength={8}
              autocomplete="off"
              onValueChange={(value) =>
                setDraft((state) => {
                  state.letters = value;
                })
              }
            />
          </Field>
        </Match>
        <Match when={draft.mode === "glyph"}>
          <fieldset class="section-icon-glyphs" aria-label={t("sidebar.sectionIcon.glyph")}>
            <For each={SIDEBAR_SECTION_GLYPHS}>
              {(glyph) => (
                <IconButton
                  label={t(SIDEBAR_SECTION_GLYPH_LABELS[glyph])}
                  variant="ghost"
                  class="section-icon-glyph"
                  aria-pressed={draft.glyph === glyph ? "true" : "false"}
                  onClick={() =>
                    setDraft((state) => {
                      state.glyph = glyph;
                    })
                  }
                >
                  <Dynamic component={SIDEBAR_SECTION_GLYPH_ICONS[glyph]} />
                </IconButton>
              )}
            </For>
          </fieldset>
        </Match>
        <Match when={draft.mode === "image"}>
          <div class="section-icon-image">
            <Button type="button" variant="outline" disabled={busy()} onClick={() => fileInput?.click()}>
              <Image aria-hidden="true" />
              {draft.reading ? t("sidebar.sectionIcon.reading") : t("sidebar.sectionIcon.chooseImage")}
            </Button>
            <Text class="section-icon-hint">{t("sidebar.sectionIcon.imageHint")}</Text>
            <Input
              ref={(element) => {
                fileInput = element;
              }}
              class="sr-only"
              type="file"
              tabindex={-1}
              aria-label={t("sidebar.sectionIcon.chooseImage")}
              accept={SIDEBAR_SECTION_ICON_SOURCE_TYPES.join(",")}
              onChange={(event) => void pickImage(event.currentTarget.files?.[0])}
            />
          </div>
        </Match>
      </Switch>

      <Show when={draft.error}>
        {(message) => (
          <Text role="alert" class="section-icon-error">
            {message()}
          </Text>
        )}
      </Show>

      <footer class="section-icon-footer">
        <Button
          type="button"
          variant="ghost"
          class="section-icon-reset"
          disabled={busy() || section()?.icon === undefined}
          onClick={() => void save(null)}
        >
          {t("sidebar.sectionIcon.reset")}
        </Button>
        <Button type="button" variant="ghost" onClick={formProps.onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy() || choice() === undefined}>
          {draft.saving ? t("common.saving") : t("common.save")}
        </Button>
      </footer>
    </form>
  );
}
