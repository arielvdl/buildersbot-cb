import type { FeedItem, FeedItemState } from "@openbot/contracts/ipc";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, onSettled, Show } from "solid-js";
import { FeedFilters } from "./FeedFilters";
import type { FeedAvatar } from "./FeedItemCard";
import { FeedJumpBar } from "./FeedJumpBar";
import { FeedTeamList } from "./FeedTeamList";
import { FeedTimeline, type FeedTimelineControl } from "./FeedTimeline";
import {
  EMPTY_FEED_FILTERS,
  type FeedFilterState,
  type FeedTeamMember,
  feedAgentKey,
  feedAgentOptions,
  feedCounts,
  feedProjectOptions,
  feedRows,
  feedTeam,
  nextFeedRowIndex,
} from "./feed-view";

export interface FeedPageProps {
  /** The cards in timeline order, the newest last. */
  items: readonly FeedItem[];
  /** The agents that the window knows, with what they do now. Agents of other servers come from `items`. */
  team: readonly FeedTeamMember[];
  loading: boolean;
  error: string | null;
  /** Opens the conversation or the channel of a card. */
  onOpen: (item: FeedItem) => void;
  /** Starts with these filters. Only a story uses it. */
  initialFilters?: Partial<FeedFilterState> | undefined;
}

/**
 * The feed page: the Team on the side, and one timeline of every run of every project, the newest at
 * the bottom. A card changes in place as its run goes on. Read only: a card that needs the person
 * opens its conversation, where the person answers.
 */
export function FeedPage(props: FeedPageProps) {
  const { t } = useText();
  const [filters, setFilters] = createStore<FeedFilterState>({ ...EMPTY_FEED_FILTERS, ...props.initialFilters });
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [view, setView] = createStore({ following: true, fresh: 0 });
  const [announcement, setAnnouncement] = createSignal("");
  let timeline: FeedTimelineControl | undefined;
  let search: HTMLInputElement | undefined;
  /** The card that the last counter showed, so the next click goes on from there. */
  let lastJump: string | null = null;

  const rows = createMemo(() => feedRows(props.items, filters));
  const cardCount = createMemo(() => rows().reduce((total, row) => (row.kind === "item" ? total + 1 : total), 0));
  const shownItems = createMemo(() => rows().flatMap((row) => (row.kind === "item" ? [row.item] : [])));
  const counts = createMemo(() => feedCounts(shownItems()));
  const projects = createMemo(() => feedProjectOptions(props.items));
  const agents = createMemo(() => feedAgentOptions(props.items));
  const team = createMemo(() => feedTeam(props.team, props.items));
  const avatars = createMemo(() => new Map(props.team.map((member) => [member.key, member])));
  const avatar = (item: FeedItem): FeedAvatar => {
    const member = avatars().get(feedAgentKey(item));
    return member
      ? { seed: member.avatarSeed, hue: member.avatarHue, url: member.avatarUrl }
      : { seed: item.agentId, hue: null, url: null };
  };

  // A screen reader hears when more runs need the person, not every step.
  createEffect(
    () => counts().needsYou,
    (count, previous) => {
      if (previous !== undefined && count > previous) setAnnouncement(t("app.feed.announce.needsYou", { count }));
    },
  );

  const jump = (state: FeedItemState) => {
    const index = nextFeedRowIndex(rows(), state, lastJump);
    if (index < 0) return;
    lastJump = rows()[index]?.key ?? null;
    timeline?.reveal(index);
  };

  onSettled(() => {
    // "/" goes to the search, as in the prototype the owner chose.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      search?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <main class="feed-page" aria-labelledby="feed-page-title">
      <header class="feed-page-header">
        <h1 id="feed-page-title">{t("app.feed.title")}</h1>
        <p class="feed-page-subtitle">{t("app.feed.subtitle")}</p>
      </header>
      <div class="feed-page-body">
        <FeedTeamList
          members={team()}
          selected={filters.agent}
          onSelect={(agent) =>
            setFilters((draft) => {
              draft.agent = agent;
            })
          }
        />
        <section class="feed-page-main" aria-labelledby="feed-page-title">
          <FeedFilters
            filters={filters}
            projects={projects()}
            agents={agents()}
            shown={cardCount()}
            total={props.items.length}
            searchRef={(element) => {
              search = element;
            }}
            onChange={(change) =>
              setFilters((draft) => {
                Object.assign(draft, change);
              })
            }
          />
          <FeedJumpBar following={view.following} fresh={view.fresh} counts={counts()} onJump={jump} />
          <Show when={props.error}>
            {(error) => (
              <p class="feed-error" role="alert">
                {t("app.feed.loadFailed")} {error()}
              </p>
            )}
          </Show>
          <FeedTimeline
            rows={rows()}
            cardCount={cardCount()}
            avatar={avatar}
            loading={props.loading}
            empty={props.items.length === 0 ? t("app.feed.empty") : t("app.feed.emptyFiltered")}
            expanded={expanded()}
            onToggleSteps={(id) => {
              const next = new Set(expanded());
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setExpanded(next);
            }}
            onOpen={props.onOpen}
            onFollowChange={(following) =>
              setView((draft) => {
                draft.following = following;
              })
            }
            onFreshChange={(fresh) =>
              setView((draft) => {
                draft.fresh = fresh;
              })
            }
            control={(control) => {
              timeline = control;
            }}
          />
          <p class="sr-only" role="status" aria-live="polite">
            {announcement()}
          </p>
        </section>
      </div>
    </main>
  );
}
