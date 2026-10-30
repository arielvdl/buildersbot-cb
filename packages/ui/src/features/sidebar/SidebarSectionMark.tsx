/**
 * The square mark of a section: its letters, a glyph, or its image. The section rail and the icon
 * editor preview draw it. It is decorative: the button around it carries the name.
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
import { Match, Switch } from "solid-js";

/** Each glyph name, as the layout stores it, and the icon it draws. */
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
} as const satisfies Record<SidebarSectionGlyph, typeof Bot>;

/** The name of each glyph, for the button that picks it. */
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
} as const satisfies Record<SidebarSectionGlyph, AppTextKey>;

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
          {(glyph) => <Dynamic component={SIDEBAR_SECTION_GLYPH_ICONS[glyph()]} class="section-rail-glyph" />}
        </Match>
        <Match when={props.icon.kind === "image" ? props.icon.dataUrl : undefined}>
          {(url) => <img class="section-rail-image" src={url()} alt="" draggable={false} />}
        </Match>
      </Switch>
    </span>
  );
}
