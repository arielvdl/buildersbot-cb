import type { ChannelTask } from "@openbot/contracts/ipc";

/**
 * The optimization `routing` (Settings > Advanced optimizations). Off, a channel routes as it did
 * before the switch existed. On:
 * - the routing generation runs on the lead's model at the lowest reasoning effort that the model
 *   takes (the `routing` purpose of `ChannelTextModel`);
 * - a follow-up in Portuguese or Spanish continues open work as an English one does, and only the
 *   tasks of the tab of the message count;
 * - the routing prompt lists the open tasks of the request's tab only, and an existing task that
 *   routing selects must be in that tab;
 * - only a change to the channel, to the routed task or to its tab discards a routing answer, and a
 *   change to the tab discards at most `ROUTING_TAB_DISCARDS` answers of one task.
 */
export const CHANNEL_ROUTING = "routing";

/** The follow-up words of the channel before the switch, in English only. */
export const ENGLISH_FOLLOW_UP =
  /^(?:also|instead|actually|please change|change that|correction|continue|resume|go on|keep going|yes|no|use that|make it)\b/iu;
/** The words that continue stopped work, before the switch. */
export const ENGLISH_RESUME = /^(?:continue|resume|go on|keep going)\b/iu;

/**
 * The end of a word. `\b` knows ASCII letters only, so it finds no end after "sí" or "não" with a
 * space after them.
 */
const WORD_END = "(?![\\p{L}\\p{N}_])";
/** A word that answers only before a punctuation mark, or as the whole message. */
const NO_ANSWER = (word: string) => `${word}(?=\\s*(?:[,.!;:]|$))`;
const RESUME_WORDS = [
  // English, as before.
  "continue",
  "resume",
  "go on",
  "keep going",
  // Portuguese.
  "continua",
  "continuar",
  "prossiga",
  "prossegue",
  "retome",
  "retoma",
  "retomar",
  "pode continuar",
  "pode seguir",
  "pode prosseguir",
  "siga em frente",
  "segue em frente",
  "vai em frente",
  // Spanish.
  "continúa",
  "sigue",
  "siga",
  "prosigue",
  "reanuda",
  "adelante",
  "puedes continuar",
  "puedes seguir",
];
const FOLLOW_UP_WORDS = [
  ...RESUME_WORDS,
  // English, as before.
  "also",
  "instead",
  "actually",
  "please change",
  "change that",
  "correction",
  "yes",
  // "No" opens many Portuguese requests ("No relatório, ..." is "In the report, ..."), so a "no" that
  // answers is one before a punctuation mark or alone. The same for the Portuguese "não".
  NO_ANSWER("no"),
  "use that",
  "make it",
  // Portuguese.
  "também",
  "além disso",
  "em vez disso",
  "ao invés disso",
  "na verdade",
  "por favor,? (?:mude|muda|altere|altera|troque|troca)",
  "(?:mude|muda|altere|altera|troque|troca) isso",
  "correção",
  "correcao",
  "sim",
  NO_ANSWER("não"),
  NO_ANSWER("nao"),
  "(?:use|usa) (?:isso|esse|essa)",
  "(?:faça|faca|faz) (?:isso|assim)",
  // Spanish. "si" without the accent is "if", so it is not here.
  "también",
  "además",
  "en vez de eso",
  "en lugar de eso",
  "en realidad",
  "de hecho",
  "por favor,? (?:cambia|cambie)",
  "(?:cambia|cambie) eso",
  "corrección",
  "correccion",
  "sí",
  "(?:usa|use) eso",
  "hazlo",
  "haz eso",
];
const anchored = (words: readonly string[]) => new RegExp(`^(?:${words.join("|")})${WORD_END}`, "iu");
const FOLLOW_UP = anchored(FOLLOW_UP_WORDS);
const RESUME = anchored(RESUME_WORDS);

/** Whether a message opens as a follow-up to open work. With the switch on, also in Portuguese and Spanish. */
export function opensFollowUp(text: string, optimized: boolean): boolean {
  return (optimized ? FOLLOW_UP : ENGLISH_FOLLOW_UP).test(text.trim());
}

/** Whether a message asks to continue stopped work. With the switch on, also in Portuguese and Spanish. */
export function asksToResume(text: string, optimized: boolean): boolean {
  return (optimized ? RESUME : ENGLISH_RESUME).test(text.trim());
}

/** How many routing answers of one task a change to its tab can discard, with the switch on. */
export const ROUTING_TAB_DISCARDS = 2;

/** What a routing answer depends on, with the switch on. */
export interface RoutingState {
  /** The channel settings and the routed task. A change here always discards the answer. */
  core: string;
  /** The tasks and active assignments of the routed task's tab. */
  tab: string;
}

/** Why `ChannelService` takes or discards a routing answer, with the switch on. */
export type RoutingCheck = "same" | "discard" | "limit";

/**
 * Compares the state after a routing generation with the state before it. A changed core discards.
 * A changed tab discards until the task has `ROUTING_TAB_DISCARDS` discards, then the answer stands:
 * the decision is checked against the current channel before it is applied.
 */
export function checkRoutingState(before: RoutingState, after: RoutingState, discards: number): RoutingCheck {
  if (before.core !== after.core) return "discard";
  if (before.tab === after.tab) return "same";
  return discards < ROUTING_TAB_DISCARDS ? "discard" : "limit";
}

/** The fields of a task that a routing answer depends on. */
export function routingTaskState({ id, revision, ownerAgentId, state }: ChannelTask) {
  return { id, revision, ownerAgentId, state };
}

/**
 * One routing generation, as the log keeps it, with the switch on: counts and times, never text.
 * `outcome` is what the channel did with the answer: `routed` (an owner, an existing task or idle),
 * `discarded` (stale, the lead routes again), `kept-after-limit` (stale, but the task reached
 * `ROUTING_TAB_DISCARDS`), `held` (a spent plan holds the lead) or `paused` (a question or a failure).
 */
export interface ChannelRoutingSample {
  outcome: "routed" | "discarded" | "kept-after-limit" | "held" | "paused";
  /** This generation of the task, from 1. */
  attempt: number;
  generationMs: number;
  promptCharacters: number;
  members: number;
  tabTasks: number;
}

/** The totals since the start of the process, with the switch on. */
export interface ChannelRoutingCounts {
  generations: number;
  discarded: number;
  keptAfterLimit: number;
}
