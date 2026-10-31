// Markup that sets the anchor from a value. The check cannot read the value, so an entry counts as
// placed when its key is a string in this file. Without that branch, the entry for it fails.
const ROWS = ["settings.value.title"] as const;

export function ValueRows() {
  return ROWS.map((row) => <div data-settings-row={row} />);
}
