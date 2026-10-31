// Which encrypted files of this computer cannot be decrypted now (voice-anywhere design, section 3.2).
//
// Every encrypted file in the application data folder uses the same system cipher. When the keychain
// item of the app changes, or a profile is copied from another app, all of them become unreadable at
// once. Each store reports this in its own place, if at all; this registry lets Settings › General
// list them together.
//
// It holds only the store, the file name and a function that reads the state now, never a value. The
// state is read at each call, so a key that the user saves again leaves the list at once.

import type { SecretHealthStore, UnreadableSecret } from "@openbot/contracts/ipc";
import type { Logger } from "@openbot/logging";

interface SecretHealthSource {
  file: string;
  unreadable: () => boolean;
}

const sources = new Map<SecretHealthStore, SecretHealthSource>();

/** Records where a store keeps its file and how to read its state. A second call for a store replaces the first. */
export function registerSecretHealthSource(store: SecretHealthStore, file: string, unreadable: () => boolean): void {
  sources.set(store, { file, unreadable });
}

/** The stores that cannot decrypt their file now, in the order in which they were registered. */
export function unreadableSecrets(): UnreadableSecret[] {
  const entries: UnreadableSecret[] = [];
  for (const [store, source] of sources) {
    // A store that throws here says nothing about its file, so it is not listed.
    let unreadable = false;
    try {
      unreadable = source.unreadable();
    } catch {
      unreadable = false;
    }
    if (unreadable) entries.push({ store, file: source.file });
  }
  return entries;
}

/** One log line at startup with the names of the unreadable files, and nothing when all are readable. */
export function logUnreadableSecrets(logger: Logger): void {
  const entries = unreadableSecrets();
  if (entries.length === 0) return;
  logger.warn("Some encrypted files cannot be decrypted with the current keychain item.", {
    files: entries.map((entry) => entry.file),
  });
}
