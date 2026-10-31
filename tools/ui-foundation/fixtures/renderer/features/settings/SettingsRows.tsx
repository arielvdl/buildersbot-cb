// The first row has a settings search entry. The second has none, so the search never finds it. The
// third writes its anchor in braces, which the check reads too, and has no entry either. The switch and
// the item have a catalog title and no anchor, so the search cannot find these two settings.
export function SettingsRows() {
  return (
    <>
      <div data-settings-row="settings.indexed.title" />
      <div data-settings-row="settings.orphan.title" />
      <div data-settings-row={"settings.braced.title"} />
      <SwitchField label={t("settings.unanchored.switch")} onChange={(on) => on > 0} />
      <Item class="settings-modal-row">
        <ItemContent>
          <ItemTitle>{t("settings.unanchored.item")}</ItemTitle>
        </ItemContent>
      </Item>
    </>
  );
}
