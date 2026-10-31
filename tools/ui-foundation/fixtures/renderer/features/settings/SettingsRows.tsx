// The first row has a settings search entry. The second has none, so the search never finds it.
export function SettingsRows() {
  return (
    <>
      <div data-settings-row="settings.indexed.title" />
      <div data-settings-row="settings.orphan.title" />
    </>
  );
}
