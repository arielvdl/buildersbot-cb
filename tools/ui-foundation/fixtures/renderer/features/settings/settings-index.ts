// The settings search index. "settings.missing.title" has no row with that anchor, so a result for
// it would open the tab and move nowhere. "settings.stray.title" is only a string in ValueRows.tsx.
export const rows = [
  { anchor: "settings.indexed.title" },
  { anchor: "settings.value.title" },
  { anchor: "settings.missing.title" },
  { anchor: "settings.stray.title" },
];
