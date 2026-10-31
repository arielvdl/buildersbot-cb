/**
 * The square mark of a section: its letters, a glyph, an emoji, or its image. The section rail and the
 * icon editor preview draw it. It is decorative: the button around it carries the name.
 *
 * The 24 glyphs of the first editor are part of the app. A glyph of the icon library loads the library
 * with `import()` the first time a mark needs it, and the tile stays empty until then. An emoji is text
 * in the system emoji font.
 */

import type { SidebarSectionGlyph, SidebarSectionIcon } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  BookOpen,
  Bot,
  Brain,
  Camera,
  ChartArea,
  Cloud,
  Code,
  Cpu,
  Crown,
  Film,
  Folder,
  Gift,
  Globe2,
  Lock,
  Mail,
  Megaphone,
  MessageCircle,
  Palette,
  ShieldCheck,
  Sparkles,
  Store,
  UsersRound,
  Workflow,
  Zap,
} from "@openbot/ui";
import { Dynamic } from "@solidjs/web";
import { createEffect, Match, Show, Switch } from "solid-js";
import { loadSectionIconLibrary, sectionIconLibrary } from "./section-icon-assets";

/** The glyphs of the first editor, as the layout stores them, and the icon each one draws. */
export const SIDEBAR_SECTION_GLYPH_ICONS = {
  bot: Bot,
  sparkles: Sparkles,
  shield: ShieldCheck,
  code: Code,
  brain: Brain,
  zap: Zap,
  globe: Globe2,
  film: Film,
  camera: Camera,
  megaphone: Megaphone,
  message: MessageCircle,
  mail: Mail,
  users: UsersRound,
  crown: Crown,
  gift: Gift,
  palette: Palette,
  book: BookOpen,
  folder: Folder,
  cloud: Cloud,
  cpu: Cpu,
  lock: Lock,
  store: Store,
  chart: ChartArea,
  workflow: Workflow,
} as const satisfies Partial<Record<SidebarSectionGlyph, typeof Bot>>;

type SidebarSectionBuiltinGlyph = keyof typeof SIDEBAR_SECTION_GLYPH_ICONS;

export function isSidebarSectionBuiltinGlyph(glyph: SidebarSectionGlyph): glyph is SidebarSectionBuiltinGlyph {
  return Object.hasOwn(SIDEBAR_SECTION_GLYPH_ICONS, glyph);
}

/** The drawing of a glyph of the first editor, or undefined for a glyph of the icon library. */
function builtinGlyphIcon(glyph: SidebarSectionGlyph): typeof Bot | undefined {
  return isSidebarSectionBuiltinGlyph(glyph) ? SIDEBAR_SECTION_GLYPH_ICONS[glyph] : undefined;
}

/** The name of each glyph of the first editor, in each interface language. */
export const SIDEBAR_SECTION_GLYPH_LABELS = {
  bot: "sidebar.sectionIcon.glyph.bot",
  sparkles: "sidebar.sectionIcon.glyph.sparkles",
  shield: "sidebar.sectionIcon.glyph.shield",
  code: "sidebar.sectionIcon.glyph.code",
  brain: "sidebar.sectionIcon.glyph.brain",
  zap: "sidebar.sectionIcon.glyph.zap",
  globe: "sidebar.sectionIcon.glyph.globe",
  film: "sidebar.sectionIcon.glyph.film",
  camera: "sidebar.sectionIcon.glyph.camera",
  megaphone: "sidebar.sectionIcon.glyph.megaphone",
  message: "sidebar.sectionIcon.glyph.message",
  mail: "sidebar.sectionIcon.glyph.mail",
  users: "sidebar.sectionIcon.glyph.users",
  crown: "sidebar.sectionIcon.glyph.crown",
  gift: "sidebar.sectionIcon.glyph.gift",
  palette: "sidebar.sectionIcon.glyph.palette",
  book: "sidebar.sectionIcon.glyph.book",
  folder: "sidebar.sectionIcon.glyph.folder",
  cloud: "sidebar.sectionIcon.glyph.cloud",
  cpu: "sidebar.sectionIcon.glyph.cpu",
  lock: "sidebar.sectionIcon.glyph.lock",
  store: "sidebar.sectionIcon.glyph.store",
  chart: "sidebar.sectionIcon.glyph.chart",
  workflow: "sidebar.sectionIcon.glyph.workflow",
} as const satisfies Record<SidebarSectionBuiltinGlyph, AppTextKey>;

/** A glyph of the first editor at once, or a glyph of the icon library when it has loaded. */
export function SectionGlyphIcon(props: { glyph: SidebarSectionGlyph; class?: string }) {
  const icon = () => builtinGlyphIcon(props.glyph) ?? sectionIconLibrary()?.icons[props.glyph];
  createEffect(
    () => builtinGlyphIcon(props.glyph),
    (builtin) => {
      if (!builtin) loadSectionIconLibrary();
    },
  );
  return (
    <Show when={icon()} fallback={<span class={props.class} />}>
      {(component) => <Dynamic component={component()} class={props.class} />}
    </Show>
  );
}

export function SidebarSectionMark(props: { icon: SidebarSectionIcon; class?: string }) {
  return (
    <span
      class={["section-rail-mark-tile", props.class]}
      data-kind={props.icon.kind}
      data-wide={props.icon.kind === "letter" && Array.from(props.icon.text).length > 1 ? "" : undefined}
      aria-hidden="true"
    >
      <Switch>
        <Match when={props.icon.kind === "letter" ? props.icon.text : undefined}>
          {(text) => <span class="section-rail-letter">{text()}</span>}
        </Match>
        <Match when={props.icon.kind === "glyph" ? props.icon.glyph : undefined}>
          {(glyph) => <SectionGlyphIcon glyph={glyph()} class="section-rail-glyph" />}
        </Match>
        <Match when={props.icon.kind === "emoji" ? props.icon.emoji : undefined}>
          {(emoji) => <span class="section-rail-emoji">{emoji()}</span>}
        </Match>
        <Match when={props.icon.kind === "image" ? props.icon.dataUrl : undefined}>
          {(url) => <img class="section-rail-image" src={url()} alt="" draggable={false} />}
        </Match>
      </Switch>
    </span>
  );
}
