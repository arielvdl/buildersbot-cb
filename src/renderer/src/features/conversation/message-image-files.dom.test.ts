import type { FilePreview } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { createMessageImageFiles } from "./message-image-files";

/** An agent port that answers each shared file with a small PNG, and counts the reads. */
function agent() {
  const reads: string[] = [];
  const preview = async (input: { path: string }): Promise<FilePreview> => {
    reads.push(input.path);
    return { name: input.path, size: 32, mimeType: "image/png", previewKind: "image", bytes: new Uint8Array(32) };
  };
  return { reads, port: { previewSharedFile: preview, previewWorkspaceFile: preview } };
}

const scope = (messageId: string) => ({ serverId: "local", messageId, agentId: undefined });

describe("createMessageImageFiles", () => {
  it("keeps the newest images within the character budget, and reads an evicted one again", async () => {
    const fake = agent();
    // A 32-byte PNG is a data: URL of 66 characters, so the budget holds two of them.
    const load = createMessageImageFiles(fake.port, 140);

    const first = await load({ kind: "shared", path: "a.png" }, scope("m1"));
    expect(first?.startsWith("data:image/png;base64,")).toBe(true);
    await load({ kind: "shared", path: "b.png" }, scope("m2"));
    await load({ kind: "shared", path: "c.png" }, scope("m3"));
    // The budget settles after each read, in the microtask after its answer.
    await Promise.resolve();

    await load({ kind: "shared", path: "c.png" }, scope("m3"));
    await load({ kind: "shared", path: "a.png" }, scope("m1"));
    expect(fake.reads).toEqual(["a.png", "b.png", "c.png", "a.png"]);
  });
});
