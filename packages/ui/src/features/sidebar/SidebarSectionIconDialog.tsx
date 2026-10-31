/**
 * The editor of a section icon: letters, a glyph, or an image from this computer, with a preview of
 * the rail item. It opens from the menu of the section header or of the rail item, and saves one
 * `set-section-icon` action. "Use the first letter" removes the icon.
 *
 * An image comes from "Choose image…", from a file dropped on the dialog, or from a pasted image. The
 * crop editor then moves and zooms it, and Save draws it on a canvas of at most 96 px: the icon is that
 * PNG or WebP image, also when the source was an SVG file.
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
import { createSignal, createStore, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import { useText } from "../../text";
import { SECTION_ICON_CROP_FRAME, SectionIconCropImage, SidebarSectionIconCrop } from "./SidebarSectionIconCrop";
import { SIDEBAR_SECTION_GLYPH_ICONS, SIDEBAR_SECTION_GLYPH_LABELS, SidebarSectionMark } from "./SidebarSectionMark";
import { sidebarSectionColorStyle } from "./section-color";
import { type SectionIconCrop, sectionIconFitCrop } from "./section-icon-crop";
import {
  loadSectionIconSource,
  renderSectionIconImage,
  type SectionIconBackground,
  type SectionIconSource,
  SIDEBAR_SECTION_ICON_SOURCE_TYPES,
  sidebarSectionIconPick,
} from "./section-icon-image";
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
        {/* A file dropped beside the form must not open in the window. */}
        <Dialog.Overlay
          class="ui-confirm-dialog-overlay"
          onDragOver={(event: DragEvent) => event.preventDefault()}
          onDrop={(event: DragEvent) => event.preventDefault()}
        >
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
  /** The picked image in the crop editor, until Save draws it. Its object URL goes with the form. */
  const [source, setSource] = createSignal<SectionIconSource | null>(null);
  const [crop, setCropSignal] = createSignal<SectionIconCrop>(sectionIconFitCrop());
  const [background, setBackgroundSignal] = createSignal<SectionIconBackground>("transparent");
  const [notice, setNotice] = createSignal<string | null>(null);
  const [dropActive, setDropActive] = createSignal(false);
  /** The image that the last Save made smaller to fit the limit. The next Save keeps it. */
  let reducedImage: string | null = null;
  onCleanup(() => source()?.release());
  const setCrop = (next: SectionIconCrop) => {
    reducedImage = null;
    setNotice(null);
    setCropSignal(next);
  };
  const setBackground = (next: SectionIconBackground) => {
    reducedImage = null;
    setNotice(null);
    setBackgroundSignal(next);
  };
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
  /** Whether Save has something to store: a choice, or an image in the crop editor. */
  const ready = () => (draft.mode === "image" && source() !== null) || choice() !== undefined;

  /** A file from the button, a drop or a paste goes into the crop editor. */
  async function pickImage(file: File | undefined, ignored = 0): Promise<void> {
    if (!file) return;
    setDraft((state) => {
      state.mode = "image";
      state.reading = true;
      state.error = null;
    });
    setNotice(ignored > 0 ? t("sidebar.sectionIcon.dropOnlyFirst") : null);
    try {
      const next = await loadSectionIconSource(file);
      source()?.release();
      reducedImage = null;
      setSource(next);
      setCropSignal(sectionIconFitCrop());
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

  /** The first image of a drop or a paste. Other files are left out, and the notice says so. */
  function pickFiles(files: readonly File[]): void {
    const { file, ignored } = sidebarSectionIconPick(files);
    if (!file) {
      setDraft((state) => {
        state.error = t("sidebar.sectionIcon.type");
      });
      return;
    }
    void pickImage(file, ignored);
  }

  /** Save draws the crop on the canvas first. A result made smaller asks for a second Save. */
  async function submit(): Promise<void> {
    const current = draft.mode === "image" ? source() : null;
    if (!current) {
      const icon = choice();
      if (icon !== undefined) void save(icon);
      return;
    }
    if (busy()) return;
    let dataUrl = reducedImage;
    if (!dataUrl) {
      setDraft((state) => {
        state.saving = true;
        state.error = null;
      });
      try {
        const result = await renderSectionIconImage(current, crop(), SECTION_ICON_CROP_FRAME, background());
        setDraft((state) => {
          state.saving = false;
        });
        if (result.reduced) {
          reducedImage = result.dataUrl;
          setNotice(t("sidebar.sectionIcon.reduced"));
          return;
        }
        dataUrl = result.dataUrl;
      } catch (cause) {
        setDraft((state) => {
          state.saving = false;
          state.error = errorMessage(cause, t("app.avatar.processFailed"));
        });
        return;
      }
    }
    await save({ kind: "image", dataUrl });
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
        void submit();
      }}
      onDragOver={(event) => {
        // Always, so a file never opens in the window. Only files light the drop zone.
        event.preventDefault();
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
          setDropActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length > 0) pickFiles(files);
      }}
      onPaste={(event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return;
        event.preventDefault();
        pickFiles(files);
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
          <Show when={draft.mode === "image" ? source() : null} fallback={<SidebarSectionMark icon={preview()} />}>
            {(current) => (
              <span class="section-rail-mark-tile" data-kind="image" aria-hidden="true">
                <SectionIconCropImage
                  url={current().url}
                  size={current().size}
                  crop={crop()}
                  background={background()}
                />
              </span>
            )}
          </Show>
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
            <Show
              when={source()}
              fallback={
                <div class="section-icon-drop" data-active={dropActive() ? "" : undefined}>
                  <Show when={draft.image} fallback={<Image class="section-icon-drop-glyph" aria-hidden="true" />}>
                    {(url) => <img class="section-icon-drop-current" src={url()} alt="" />}
                  </Show>
                  <span>{t("sidebar.sectionIcon.dropHere")}</span>
                </div>
              }
            >
              {(current) => (
                <SidebarSectionIconCrop
                  url={current().url}
                  size={current().size}
                  crop={crop()}
                  background={background()}
                  onCropChange={setCrop}
                  onBackgroundChange={setBackground}
                />
              )}
            </Show>
            <Button type="button" variant="outline" disabled={busy()} onClick={() => fileInput?.click()}>
              <Image aria-hidden="true" />
              {draft.reading
                ? t("sidebar.sectionIcon.reading")
                : source()
                  ? t("sidebar.sectionIcon.chooseAnother")
                  : t("sidebar.sectionIcon.chooseImage")}
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
      <Show when={notice()}>
        {(message) => (
          <Text role="status" class="section-icon-hint">
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
        <Button type="submit" disabled={busy() || !ready()}>
          {draft.saving ? t("common.saving") : t("common.save")}
        </Button>
      </footer>
    </form>
  );
}
