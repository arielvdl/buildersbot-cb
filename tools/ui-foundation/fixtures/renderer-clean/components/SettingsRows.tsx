// Each row has an entry in settings-index.ts, and each entry has a row: written as text in each form,
// and set from a property of a value. A row with a catalog title needs no anchor of its own inside an
// element with an anchor, with data-settings-row-skip, or when its title is not a catalog key.
const VALUE_ROWS = [{ title: "settings.clean.value" }] as const;

export function SettingsRows(props: { name: string }) {
  return (
    <>
      <div data-settings-row="settings.clean.title" />
      <div data-settings-row='settings.clean.quoted' />
      {VALUE_ROWS.map((row) => (
        <div data-settings-row={row.title} />
      ))}
      <SwitchField data-settings-row="settings.clean.switch" label={t("settings.clean.switch")} />
      <SettingsSection data-settings-row="settings.clean.section" title={t("settings.clean.section")}>
        <Item class="settings-modal-row">
          <ItemTitle>{t("settings.clean.inside")}</ItemTitle>
        </Item>
        <SwitchField label={i18n.t("settings.clean.insideSwitch")} onChange={(on) => on > 0} />
      </SettingsSection>
      <Item data-settings-row-skip="status line" class="settings-modal-row">
        <ItemTitle>{t("settings.clean.status")}</ItemTitle>
      </Item>
      <Item class="settings-modal-row">
        <ItemTitle>{props.name}</ItemTitle>
      </Item>
    </>
  );
}
