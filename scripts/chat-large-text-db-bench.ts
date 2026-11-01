// Measures the main-process work that one streamed flush of a very large agent reply costs, on the
// real database of a temporary profile. No app, provider, account or network is started.
//
// For each reply size it times, as the delta buffer runs them on each flush (100 ms or 8 KiB):
// - `persistStreamingMessage`, which writes the streamed message whole to `message_json` and to its
//   event payload;
// - the whole-snapshot signature and clone that `publishConversation` runs on every non-delta event;
// - `cleanAgentMessageText`, which the renderer runs over the whole body on each received delta.
//
// Run: bun scripts/chat-large-text-db-bench.ts [--sizes=10000,100000,1000000,5000000] [--flushes=20]
// Writes .openbot-build/chat-large-text-db-bench/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import { conversationContentSignature } from "../src/backend/agent/delivery-content";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { BuildersBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/chat-large-text-db-bench");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const sizes = (option("sizes") ?? "10000,100000,1000000,5000000").split(",").map(Number);
const flushes = Number(option("flushes") ?? "20");
assert.ok(Number.isInteger(flushes) && flushes >= 3, "--flushes takes a whole number, 3 or more.");
const FLUSH_TEXT = "x".repeat(8 * 1024);

const agent: AgentSummary = {
  id: "bench",
  provider: "codex",
  name: "Bench",
  title: "",
  description: "",
  notifications: true,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: "openbot-thread-bench",
  workspacePath: "/tmp/openbot-bench",
  preview: "",
  updatedAt: "2026-11-01T10:00:00.000Z",
  avatarSeed: "bench",
  avatarHue: null,
  avatarUrl: null,
};

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100) / 100;
}

function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const root = await mkdtemp(join(tmpdir(), "openbot-large-text-bench-"));
const rows: Record<string, number>[] = [];
try {
  for (const bytes of sizes) {
    const database = new BuildersBotDatabase(join(root, `profile-${bytes}`));
    await runCauseEffect(database.initialize());
    try {
      database.replaceAgents("agents-import", [agent], "agents.imported");
      const snapshot: ConversationSnapshot = {
        agentId: agent.id,
        threadId: agent.threadId,
        activeTurnId: "turn-1",
        revision: 0,
        messages: Array.from({ length: 40 }, (_, index) => ({
          id: `settled-${index}`,
          turnId: "turn-0",
          author: index % 2 === 0 ? "user" : "assistant",
          text: `Settled message ${index}`,
          createdAt: new Date(Date.UTC(2026, 10, 1, 10, 0, index)).toISOString(),
          status: "completed",
        })),
      };
      const live = {
        id: "assistant-live",
        turnId: "turn-1",
        author: "assistant" as const,
        text: "y".repeat(bytes),
        createdAt: "2026-11-01T11:00:00.000Z",
        status: "streaming" as const,
      };
      snapshot.messages.push(live);
      snapshot.revision = database.persistConversation(snapshot, "turn.started", { turnId: "turn-1" }).revision;
      const persist: number[] = [];
      const signature: number[] = [];
      const clone: number[] = [];
      const clean: number[] = [];
      for (let flush = 0; flush < flushes; flush += 1) {
        live.text += FLUSH_TEXT;
        persist.push(
          timed(() => {
            snapshot.revision = database.persistStreamingMessage({
              snapshot,
              messageId: live.id,
              eventType: "response.delta-flushed",
              detail: { turnId: "turn-1", messageId: live.id, bytes: FLUSH_TEXT.length },
            });
          }),
        );
        signature.push(timed(() => conversationContentSignature(snapshot)));
        clone.push(timed(() => structuredClone(snapshot)));
        clean.push(timed(() => cleanAgentMessageText(live.text)));
      }
      const stored = database.readConversation(agent.id, agent.threadId).messages.at(-1);
      assert.equal(stored?.text.length, live.text.length, "The flushes keep the whole streamed text.");
      const row = {
        bytes,
        persistMsPerFlush: median(persist),
        signatureMs: median(signature),
        cloneMs: median(clone),
        cleanTextMs: median(clean),
        // A reply that grows to this size in 8 KiB flushes: the database writes summed over all of them.
        persistMsWholeReply: Math.round((median(persist) * bytes) / FLUSH_TEXT.length),
      };
      rows.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
    } finally {
      database.close();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });
writeFileSync(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
