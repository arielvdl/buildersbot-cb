import type { CleanupCandidate } from "@openbot/contracts/ipc";
import { Button, Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle, Spinner } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import { type FilesPort, filesPort } from "./files-port";

function size(bytes: number): string {
  return bytes >= 1_073_741_824
    ? `${(bytes / 1_073_741_824).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}

/**
 * Storage > Cleanup: what Builders Bot found to be old on this computer, one row each. A scan is
 * asked for, never run in the background. The question before a removal is a native dialog in
 * main, so this panel only names a row; a row with a blocker says what to do first and has no button.
 */
export function StorageCleanup(props: { calls?: FilesPort }) {
  const { t } = useText();
  const calls = () => props.calls ?? filesPort();
  const port = () => {
    const { getCleanupCandidates, removeCleanupCandidate } = calls().storage;
    return getCleanupCandidates && removeCleanupCandidate
      ? { getCleanupCandidates, removeCleanupCandidate }
      : undefined;
  };
  const [rows, setRows] = createSignal<CleanupCandidate[] | null>(null);
  const [scanning, setScanning] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  async function scan(): Promise<void> {
    const current = port();
    if (!current) return;
    setScanning(true);
    setFailed(false);
    try {
      setRows((await current.getCleanupCandidates()).candidates);
    } catch {
      setFailed(true);
    } finally {
      setScanning(false);
    }
  }

  async function remove(id: string): Promise<void> {
    const current = port();
    if (!current) return;
    try {
      if ((await current.removeCleanupCandidate({ id })).removed)
        setRows((list) => list?.filter((row) => row.id !== id) ?? null);
    } catch {
      setFailed(true);
    }
  }

  const reason = (row: CleanupCandidate) =>
    row.reason === "merged"
      ? t("files.tidy.merged")
      : t(row.kind === "worktree" ? "files.tidy.stale" : "files.tidy.devProfileIdle", { days: row.idleDays });

  return (
    <Show when={port()}>
      <section class="settings-modal-section">
        <h3>{t("files.tidy.title")}</h3>
        <p>{t("files.tidy.description")}</p>
        <Button variant="outline" type="button" disabled={scanning()} onClick={() => void scan()}>
          <Show when={scanning()} fallback={t("files.tidy.scan")}>
            <Spinner /> {t("files.tidy.scanning")}
          </Show>
        </Button>
        <Show when={failed()}>
          <p role="alert">{t("files.tidy.failed")}</p>
        </Show>
        <Show when={rows()}>
          {(list) => (
            <Show when={list().length > 0} fallback={<p>{t("files.tidy.empty")}</p>}>
              <ItemGroup class="settings-modal-card">
                <For each={list()}>
                  {(row) => (
                    <Item>
                      <ItemContent>
                        <ItemTitle>
                          {row.label} · {size(row.bytes)}
                        </ItemTitle>
                        <ItemDescription>
                          {row.kind === "worktree" ? t("files.tidy.worktree") : t("files.tidy.devProfile")}
                          {row.detail ? ` · ${row.detail}` : ""} · {reason(row)}
                          <Show when={row.blocker}>{(blocker) => <> · {t(`files.tidy.${blocker()}`)}</>}</Show>
                        </ItemDescription>
                      </ItemContent>
                      <Show when={row.blocker === null}>
                        <ItemActions>
                          <Button variant="outline" type="button" onClick={() => void remove(row.id)}>
                            {t("files.tidy.remove")}
                          </Button>
                        </ItemActions>
                      </Show>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </Show>
          )}
        </Show>
      </section>
    </Show>
  );
}
