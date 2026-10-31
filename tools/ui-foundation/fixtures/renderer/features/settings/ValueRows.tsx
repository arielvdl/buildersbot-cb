// Markup that sets the anchor from a property of a value. The check cannot read the value, so an entry
// counts as placed when its key is the value of that property in this file. Without that branch, the
// entry for "settings.value.title" fails. "settings.stray.title" is also a string of this file, but
// not a `title:`, so its entry fails: a value anchor does not place every string of its file.
const ROWS = [{ title: "settings.value.title" }] as const;
const STRAY = "settings.stray.title";

export function ValueRows() {
  return ROWS.map((row) => <div data-settings-row={row.title} aria-label={STRAY} />);
}
