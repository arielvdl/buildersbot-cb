// Each row has an entry in settings-index.ts, and each entry has a row: one written as text, one set
// from a value.
const VALUE_ROWS = ["settings.clean.value"] as const;

export function SettingsRows() {
  return (
    <>
      <div data-settings-row="settings.clean.title" />
      {VALUE_ROWS.map((row) => (
        <div data-settings-row={row} />
      ))}
    </>
  );
}
