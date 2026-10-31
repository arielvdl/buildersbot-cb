/**
 * The name of a section in a dialog: the rail opens it to make a section or to rename one. Enter saves,
 * Escape closes. A new section shows in the rail and the rail selects it. The section list keeps its
 * own name field in the section header.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { Button, Dialog, Field, IconButton, Input, Text, X } from "@openbot/ui";
import { createStore, Show, untrack } from "solid-js";
import { useText } from "../../text";
import { useSidebarScope } from "./sidebar-scope";
import { sidebarSectionNameProblem } from "./sidebar-section-rail";
import type { SidebarSectionNameDialogTarget } from "./stores/section-rail-store";

export function SidebarSectionNameDialog() {
  const { sectionRail } = useSidebarScope();
  let input: HTMLInputElement | undefined;
  return (
    <Dialog.Root
      open={sectionRail.nameDialog() !== null}
      onOpenChange={(open) => {
        if (!open) sectionRail.closeNameDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="ui-confirm-dialog-overlay">
          <Dialog.Content
            as="section"
            class="ui-dialog-content section-icon-dialog section-name-dialog"
            onOpenAutoFocus={(event: Event) => {
              event.preventDefault();
              input?.focus();
              input?.select();
            }}
          >
            {/* Keyed by target: each open starts from the saved name. */}
            <Show when={sectionRail.nameDialog()} keyed>
              {(target) => (
                <SectionNameForm
                  target={target}
                  setInput={(element) => {
                    input = element;
                  }}
                  onClose={sectionRail.closeNameDialog}
                />
              )}
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The name as typed, the save in flight, and why the last try failed. */
interface NameDraft {
  name: string;
  saving: boolean;
  error: string | null;
}

function SectionNameForm(formProps: {
  target: SidebarSectionNameDialogTarget;
  setInput: (element: HTMLInputElement) => void;
  onClose: () => void;
}) {
  const { props, sectionRail } = useSidebarScope();
  const { t, errorMessage } = useText();
  const target = formProps.target;
  // The section as the dialog opened on it. A save sends a new layout, which must not reset the draft.
  const renamed = untrack(() =>
    target.kind === "rename" ? props.layout.sections.find((section) => section.id === target.sectionId) : undefined,
  );
  const [draft, setDraft] = createStore<NameDraft>({ name: renamed?.name ?? "", saving: false, error: null });

  async function save(): Promise<void> {
    if (draft.saving) return;
    const name = draft.name.trim();
    const problem = sidebarSectionNameProblem(name, props.layout.sections, renamed?.id);
    if (problem) {
      setDraft((state) => {
        state.error = t(problem === "required" ? "sidebar.section.nameRequired" : "sidebar.section.nameUnique");
      });
      return;
    }
    if (renamed && name === renamed.name) {
      formProps.onClose();
      return;
    }
    setDraft((state) => {
      state.saving = true;
      state.error = null;
    });
    const before = new Set(props.layout.sections.map((section) => section.id));
    try {
      await props.onMutateLayout(
        renamed
          ? { type: "rename", sectionId: renamed.id, name }
          : {
              type: "create",
              name,
              ...(target.kind === "create" && target.agentId ? { agentId: target.agentId } : {}),
            },
      );
      if (!renamed) sectionRail.selectWhenCreated(name, before);
      formProps.onClose();
    } catch (cause) {
      setDraft((state) => {
        state.saving = false;
        state.error = errorMessage(cause, t("sidebar.section.saveFailed"));
      });
    }
  }

  return (
    <form
      class="section-icon-form"
      novalidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header class="section-icon-header">
        <Dialog.Title as="h2" class="section-icon-title">
          {renamed ? t("sidebar.section.renameLabel") : t("sidebar.new.section")}
        </Dialog.Title>
        <IconButton label={t("common.close")} variant="ghost" onClick={formProps.onClose}>
          <X />
        </IconButton>
      </header>
      <Field label={t("sidebar.sectionName.field")} error={draft.error ?? undefined}>
        <Input
          ref={formProps.setInput}
          value={draft.name}
          maxlength={INPUT_LIMITS.sidebarSectionName}
          autocomplete="off"
          disabled={draft.saving}
          aria-invalid={draft.error ? "true" : undefined}
          onValueChange={(value) =>
            setDraft((state) => {
              state.name = value;
              state.error = null;
            })
          }
        />
      </Field>
      <Show when={draft.error}>
        {(message) => (
          <Text role="alert" class="sr-only">
            {message()}
          </Text>
        )}
      </Show>
      <footer class="section-icon-footer">
        <Button type="button" variant="ghost" onClick={formProps.onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={draft.saving}>
          {draft.saving ? t("common.saving") : renamed ? t("common.save") : t("common.create")}
        </Button>
      </footer>
    </form>
  );
}
